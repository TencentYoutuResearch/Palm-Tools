//! One ACP connection owns each structured session and every pending interaction.
//! UI ids are opaque local tokens; JSON-RPC ids and option ids never enter a PTY.
use crate::{Ctx, EventEnvelope, SessionId};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
    time::Duration,
};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Registry(Mutex<HashMap<SessionId, Arc<Client>>>);
impl Drop for Registry {
    fn drop(&mut self) {
        for (_, client) in self.0.get_mut().drain() {
            client.shutdown();
        }
    }
}
impl Registry {
    pub fn get(&self, id: SessionId) -> Option<Arc<Client>> {
        self.0.lock().get(&id).cloned()
    }
    pub fn insert(&self, id: SessionId, client: Arc<Client>) {
        self.0.lock().insert(id, client);
    }
    pub fn remove(&self, id: SessionId) {
        if let Some(client) = self.0.lock().remove(&id) {
            client.shutdown();
        }
    }
}
#[derive(Clone)]
struct Interaction {
    rpc_id: Option<Value>,
    method: String,
    params: Value,
}
pub struct Client {
    ctx: Weak<Ctx>,
    local_id: SessionId,
    native_id: Mutex<String>,
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    sequence: AtomicU64,
    closed: AtomicBool,
    busy: AtomicBool,
    requests: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    interactions: Mutex<HashMap<String, Interaction>>,
    response_lock: tokio::sync::Mutex<()>,
    stream: Mutex<Option<(String, String)>>,
}
impl Client {
    pub async fn start(
        ctx: Arc<Ctx>,
        id: SessionId,
        backend: &kode_core::config::BackendConfig,
        cwd: &Path,
        mode: Option<&str>,
        model: Option<&str>,
        resume: Option<&str>,
    ) -> Result<Arc<Self>, String> {
        if resume.is_some_and(|sid| {
            ctx.acp
                .0
                .lock()
                .values()
                .any(|client| !client.closed.load(Ordering::Acquire) && client.session_id() == sid)
        }) {
            return Err(
                "This ACP session already has a live owner; close it before restoring".into(),
            );
        }
        // Preserve configured agent arguments; only ACP supplies the transport flag.
        let mut command = Command::new(kode_core::pty::resolve_spawn_command(&backend.command));
        command
            .args(&backend.args)
            .arg("--acp")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(model) = model.or(backend.default_model.as_deref()) {
            command.args(["--model", model]);
        }
        command
            .env("KODE_HOST", "1")
            .env("KODE_MEMORY_ROOT", crate::resolve_memory_root())
            .env_remove("KODE_HOOK_SOCK")
            .env_remove("KODE_SESSION_ID");
        let mut child = command
            .spawn()
            .map_err(|e| format!("ACP spawn failed: {e}"))?;
        let writer = child.stdin.take().ok_or("ACP stdin missing")?;
        let stdout = child.stdout.take().ok_or("ACP stdout missing")?;
        let stderr = child.stderr.take().ok_or("ACP stderr missing")?;
        let client = Arc::new(Self {
            ctx: Arc::downgrade(&ctx),
            local_id: id,
            native_id: Mutex::new(String::new()),
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            sequence: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            requests: Mutex::new(HashMap::new()),
            interactions: Mutex::new(HashMap::new()),
            response_lock: tokio::sync::Mutex::new(()),
            stream: Mutex::new(None),
        });
        let weak = Arc::downgrade(&client);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Some(client) = weak.upgrade() else { break };
                match line {
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(frame) => client.receive(frame),
                        Err(_) => {
                            client.fail("Invalid ACP JSON frame");
                            break;
                        }
                    },
                    Err(_) => break,
                }
            }
            if let Some(client) = weak.upgrade() {
                client.fail("ACP connection closed");
            }
        });
        // Drain diagnostics without retaining arbitrary output or blocking stdout.
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        let setup = async {
            let initialized = client.request("initialize", json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{}}},"clientInfo":{"name":"kode-mobile-bridge","version":"0.1.0"}}), Some(Duration::from_secs(30))).await?;
            let result = if let Some(sid) = resume {
                *client.native_id.lock() = sid.to_string();
                if initialized["agentCapabilities"]["loadSession"] != true { return Err("Agent does not support ACP session/load".into()); }
                client.request("session/load", json!({"sessionId":sid,"cwd":cwd,"mcpServers":[]}), Some(Duration::from_secs(30))).await?
            } else { client.request("session/new", json!({"cwd":cwd,"mcpServers":[]}), Some(Duration::from_secs(30))).await? };
            let sid = result["sessionId"].as_str().or(resume).filter(|s| !s.is_empty()).ok_or("ACP session id missing")?.to_string();
            *client.native_id.lock() = sid.clone();
            if let Some(mode) = mode.filter(|m| *m != "default") {
                client.request("session/set_mode", json!({"sessionId":sid,"modeId": if mode == "bypass" { "bypassPermissions" } else { mode }}), Some(Duration::from_secs(30))).await?;
            }
            Ok::<(), String>(())
        }.await;
        if let Err(error) = setup {
            client.shutdown();
            return Err(error);
        }
        if client.closed.load(Ordering::Acquire) {
            return Err("ACP exited during creation".into());
        }
        Ok(client)
    }
    pub fn session_id(&self) -> String {
        self.native_id.lock().clone()
    }
    fn write(&self, frame: Value) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("ACP connection is closed".into());
        }
        let mut writer = self.writer.lock();
        serde_json::to_writer(&mut *writer, &frame).map_err(|e| e.to_string())?;
        writer
            .write_all(b"\n")
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }
    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let id = format!("kode-{}", self.sequence.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.requests.lock().insert(id.clone(), tx);
        if let Err(error) =
            self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        {
            self.requests.lock().remove(&id);
            return Err(error);
        }
        let result = if let Some(timeout) = timeout {
            match tokio::time::timeout(timeout, rx).await {
                Ok(value) => value.map_err(|_| "ACP response channel closed".to_string()),
                Err(_) => Err("ACP response timed out; execution outcome unknown".into()),
            }
        } else {
            rx.await
                .map_err(|_| "ACP response channel closed".to_string())
        };
        self.requests.lock().remove(&id);
        result?
    }
    fn emit(&self, kind: &str, payload: Value) {
        if let Some(ctx) = self.ctx.upgrade() {
            ctx.bus
                .emit(EventEnvelope::new(self.local_id, kind, payload));
        }
    }
    fn status(&self, busy: bool) {
        if let Some(ctx) = self.ctx.upgrade() {
            if let Some(session) = ctx.sessions.lock().get_mut(&self.local_id) {
                if busy {
                    session.mark_turn_start();
                } else {
                    session.mark_turn_end();
                }
            }
        }
        self.emit(
            "session.status",
            json!({"status":if busy {"busy"} else {"idle"}}),
        );
    }
    pub fn prompt(self: &Arc<Self>, text: String) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("ACP connection closed".into());
        }
        if !self.interactions.lock().is_empty() {
            return Err("Resolve pending ACP interactions before sending a message".into());
        }
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err("ACP session is still running".into());
        }
        *self.stream.lock() = None;
        self.status(true);
        self.emit(
            "message",
            json!({"id":uuid::Uuid::new_v4().to_string(),"role":"user","text":text,"timestamp_ms":crate::now_ms(),"source":"acp"}),
        );
        let client = Arc::clone(self);
        tokio::spawn(async move {
            let result = client
                .request(
                    "session/prompt",
                    json!({"sessionId":client.session_id(),"prompt":[{"type":"text","text":text}]}),
                    None,
                )
                .await;
            for token in client
                .interactions
                .lock()
                .drain()
                .map(|(token, _)| token)
                .collect::<Vec<_>>()
            {
                client.emit("interaction.resolved", json!({"request_id":token}));
            }
            client.flush_message();
            client.emit(
                "session.attention_cleared",
                json!({"reason":"acp_turn_finished"}),
            );
            client.busy.store(false, Ordering::Release);
            if !client.closed.load(Ordering::Acquire) {
                client.status(false);
            }
            if let Err(error) = result {
                client.emit("system", json!({"text":error}));
            }
        });
        Ok(())
    }
    pub async fn set_mode(&self, mode: &str) -> Result<(), String> {
        self.request("session/set_mode", json!({"sessionId":self.session_id(),"modeId":if mode == "bypass" {"bypassPermissions"} else {mode}}), Some(Duration::from_secs(30))).await.map(|_| ())
    }
    pub fn cancel(&self) -> Result<(), String> {
        let interactions = self.interactions.lock().drain().collect::<Vec<_>>();
        for (token, item) in interactions {
            if let Some(id) = item.rpc_id {
                let result = if item.method == "elicitation/create" {
                    json!({"action":"cancel"})
                } else {
                    json!({"outcome":{"outcome":"cancelled"}})
                };
                self.write(json!({"jsonrpc":"2.0","id":id,"result":result}))?;
            }
            self.emit("interaction.resolved", json!({"request_id":token}));
        }
        self.emit(
            "session.attention_cleared",
            json!({"reason":"acp_cancelled"}),
        );
        self.write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session_id()}}))
    }
    fn receive(&self, frame: Value) {
        let Some(method) = frame["method"].as_str() else {
            if let Some(id) = frame["id"].as_str() {
                if let Some(tx) = self.requests.lock().remove(id) {
                    let _ = tx.send(if frame.get("error").is_some() {
                        Err(frame["error"].to_string())
                    } else {
                        Ok(frame["result"].clone())
                    });
                }
            }
            return;
        };
        let params = &frame["params"];
        if frame.get("id").is_some() {
            if params["sessionId"].as_str() != Some(self.session_id().as_str()) {
                self.reject(
                    &frame["id"],
                    -32602,
                    "Session does not belong to this connection",
                );
                return;
            }
            match method {
                "session/request_permission" if valid_permission(params) => {
                    self.register(method, Some(frame["id"].clone()), params.clone());
                }
                "elicitation/create"
                    if params["mode"] == "form" && valid_schema(&params["requestedSchema"]) =>
                {
                    self.register(method, Some(frame["id"].clone()), params.clone());
                }
                "session/request_permission" | "elicitation/create" => self.reject(
                    &frame["id"],
                    -32602,
                    "Unsupported or invalid interaction schema",
                ),
                _ => self.reject(&frame["id"], -32601, "Client method not supported"),
            }
            return;
        }
        if method != "session/update"
            || params["sessionId"].as_str() != Some(self.session_id().as_str())
        {
            return;
        }
        let update = &params["update"];
        if let Some(raw) = update["_meta"]["codebuddy.ai/interruptionRequest"].as_object() {
            let mut raw = Value::Object(raw.clone());
            raw["metadata"] = update["_meta"].clone();
            if self.busy.load(Ordering::Acquire)
                && matches!(
                    raw["toolName"].as_str(),
                    Some("AskUserQuestion" | "ExitPlanMode")
                )
                && raw["toolCallId"].is_string()
            {
                self.register("_codebuddy.ai/resolveInterruption", None, raw);
            }
        }
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                if let Some(text) = update["content"]["text"].as_str() {
                    let mut stream = self.stream.lock();
                    let (id, full_text) = stream
                        .get_or_insert_with(|| (uuid::Uuid::new_v4().to_string(), String::new()));
                    full_text.push_str(text);
                    self.emit("message", json!({"id":id,"role":"assistant","text":full_text,"timestamp_ms":crate::now_ms(),"source":"acp","streaming":true,"revision":self.sequence.fetch_add(1, Ordering::Relaxed)}));
                }
            }
            Some("tool_call" | "tool_call_update") => {
                self.flush_message();
                self.emit("tool_use", json!({"tool_use_id":update["toolCallId"],"name":update["name"].as_str().or(update["title"].as_str()).unwrap_or("Tool"),"input":update["rawInput"],"status":update["status"],"content":update["content"]}));
            }
            _ => {}
        }
    }
    fn flush_message(&self) {
        let message = self.stream.lock().take();
        if let Some((id, text)) = message {
            self.emit("message", json!({"id":id,"role":"assistant","text":text,"timestamp_ms":crate::now_ms(),"source":"acp","streaming":false,"revision":self.sequence.fetch_add(1, Ordering::Relaxed)}));
        }
    }
    fn reject(&self, id: &Value, code: i32, message: &str) {
        let _ =
            self.write(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}));
    }
    fn register(&self, method: &str, rpc_id: Option<Value>, params: Value) {
        self.flush_message();
        let mut interactions = self.interactions.lock();
        let tool_id = if method == "session/request_permission" {
            params["toolCall"]["toolCallId"].as_str()
        } else {
            params["toolCallId"].as_str()
        };
        if let Some(tool_id) = tool_id {
            if method == "_codebuddy.ai/resolveInterruption"
                && interactions.values().any(|item| {
                    item.method != "_codebuddy.ai/resolveInterruption"
                        && (item.params["toolCall"]["toolCallId"] == tool_id
                            || item.params["toolCallId"] == tool_id)
                })
            {
                return;
            }
            if method != "_codebuddy.ai/resolveInterruption" {
                let replaced = interactions
                    .iter()
                    .filter(|(_, item)| {
                        item.method == "_codebuddy.ai/resolveInterruption"
                            && item.params["toolCallId"] == tool_id
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in replaced {
                    interactions.remove(&id);
                    self.emit("interaction.resolved", json!({"request_id":id}));
                }
            }
        }
        if interactions.values().any(|item| {
            item.method == method
                && item.rpc_id == rpc_id
                && (rpc_id.is_some() || item.params["toolCallId"] == params["toolCallId"])
        }) {
            return;
        }
        let token = format!("acp-{}", uuid::Uuid::new_v4());
        interactions.insert(
            token.clone(),
            Interaction {
                method: method.into(),
                rpc_id,
                params: params.clone(),
            },
        );
        drop(interactions);
        if method == "elicitation/create" {
            self.emit("ask_user_question", json!({"source":"acp_form","question_id":token,"request_id":token,"question":params["message"],"agent":"CodeBuddy","requested_schema":params["requestedSchema"]}));
        } else if method == "session/request_permission" {
            let options = params["options"].as_array().unwrap().iter().map(|option| json!({"label":option["name"],"option_id":option["optionId"],"kind":option["kind"]})).collect::<Vec<_>>();
            self.emit("ask_user_question", json!({"source":"acp_permission","question_id":token,"request_id":token,"header":"Permission requested","question":params["toolCall"]["title"],"context":serde_json::to_string_pretty(&params["toolCall"]).unwrap_or_default(),"options":options}));
        } else if params["toolName"] == "ExitPlanMode" {
            let plan = params["metadata"]["codebuddy.ai/planContent"]
                .as_str()
                .or(params["toolInput"]["plan"].as_str())
                .or(params["plan"].as_str())
                .unwrap_or("");
            self.emit(
                "plan_proposed",
                json!({"source":"acp","plan_id":token,"plan_md":plan}),
            );
        } else if let Some(questions) = params["toolInput"]["questions"].as_array() {
            if questions.is_empty()
                || !questions.iter().all(|q| {
                    q["question"].is_string()
                        && q["options"]
                            .as_array()
                            .is_some_and(|options| options.iter().all(|o| o["label"].is_string()))
                })
            {
                self.fail("Agent supplied invalid structured questions");
                return;
            }
            let mut properties = serde_json::Map::new();
            let mut required = Vec::new();
            for (index, question) in questions.iter().enumerate() {
                let key = question["id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("q_{index}"));
                let labels = question["options"]
                    .as_array()
                    .map(|options| {
                        options
                            .iter()
                            .map(|o| o["label"].clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let property = if question["multiSelect"] == true {
                    json!({"type":"array","title":question["question"],"items":{"type":"string","enum":labels},"minItems":1})
                } else {
                    json!({"type":"string","title":question["question"],"enum":labels,"allow_custom":true,"minLength":1})
                };
                required.push(key.clone());
                properties.insert(key, property);
            }
            self.emit("ask_user_question", json!({"source":"acp_questions","question_id":token,"request_id":token,"question":"CodeBuddy needs your answers","agent":"CodeBuddy","requested_schema":{"type":"object","properties":properties,"required":required}}));
        }
    }

    pub async fn answer_choice(
        &self,
        question_id: &str,
        index: u32,
        text: Option<&str>,
        _submit: bool,
    ) -> Result<(), String> {
        let item = self
            .interactions
            .lock()
            .get(question_id)
            .cloned()
            .ok_or("Interaction is no longer pending")?;
        if item.method != "session/request_permission" {
            return Err("ACP questions require one atomic structured response".into());
        }
        if text.is_some_and(|text| !text.is_empty()) {
            return Err("Permission options cannot include free text".into());
        }
        let option_id = item.params["options"]
            .get(index as usize)
            .and_then(|option| option["optionId"].as_str())
            .ok_or("Unknown permission option")?;
        self.respond(question_id, json!({"optionId":option_id}))
            .await
    }
    pub async fn respond(&self, token: &str, response: Value) -> Result<(), String> {
        let _guard = self.response_lock.lock().await;
        self.respond_locked(token, response).await
    }
    async fn respond_locked(&self, token: &str, response: Value) -> Result<(), String> {
        let item = self
            .interactions
            .lock()
            .get(token)
            .cloned()
            .ok_or("Interaction is no longer pending on this connection")?;
        let result = if item.method == "session/request_permission" {
            let option_id = response["optionId"]
                .as_str()
                .ok_or("optionId is required")?;
            if !item.params["options"]
                .as_array()
                .is_some_and(|options| options.iter().any(|o| o["optionId"] == option_id))
            {
                return Err("Unknown permission optionId".into());
            }
            json!({"outcome":{"outcome":"selected","optionId":option_id}})
        } else if item.method == "elicitation/create" {
            let action = response["action"]
                .as_str()
                .filter(|a| matches!(*a, "accept" | "decline" | "cancel"))
                .ok_or("Invalid elicitation action")?;
            if action == "accept" {
                validate_content(&item.params["requestedSchema"], &response["content"])?;
                json!({"action":action,"content":response["content"]})
            } else {
                json!({"action":action})
            }
        } else {
            let decision = response["decision"]
                .as_str()
                .filter(|d| matches!(*d, "allow" | "deny"))
                .ok_or("Explicit decision required")?;
            let answers = if response.get("content").is_some() {
                &response["content"]
            } else {
                &response["answers"]
            };
            if item.params["toolName"] == "AskUserQuestion" && decision == "allow" {
                validate_answers(&item.params, answers)?;
            }
            let mut result = json!({"sessionId":self.session_id(),"toolCallId":item.params["toolCallId"],"decision":decision});
            if !answers.is_null() {
                result["answers"] = answers.clone();
            }
            result
        };
        // Retire BEFORE writing: delivery failures/timeouts are unknown outcomes,
        // never permission to replay an approval against a later request.
        self.interactions.lock().remove(token);
        let delivery = if let Some(rpc_id) = item.rpc_id {
            self.write(json!({"jsonrpc":"2.0","id":rpc_id,"result":result}))
                .map(|_| Value::Null)
        } else {
            self.request(&item.method, result, Some(Duration::from_secs(30)))
                .await
        };
        if delivery.is_err() {
            self.fail("ACP response delivery failed; outcome unknown; restart the session");
        }
        self.emit("interaction.resolved", json!({"request_id":token}));
        if self.interactions.lock().is_empty() {
            self.emit(
                "session.attention_cleared",
                json!({"reason":"acp_response","request_id":token}),
            );
        }
        delivery.map(|_| ())
    }
    fn fail(&self, reason: &str) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let tokens = self
            .interactions
            .lock()
            .drain()
            .map(|(token, _)| token)
            .collect::<Vec<_>>();
        for token in tokens {
            self.emit("interaction.resolved", json!({"request_id":token}));
        }
        for (_, tx) in self.requests.lock().drain() {
            let _ = tx.send(Err(reason.into()));
        }
        if let Some(ctx) = self.ctx.upgrade() {
            if let Some(session) = ctx.sessions.lock().get_mut(&self.local_id) {
                session.mark_exited(None);
            }
        }
        self.emit("session.attention_cleared", json!({"reason":"acp_closed"}));
        self.emit("session.exited", json!({"reason":reason}));
        let _ = self.child.lock().kill();
        let _ = self.child.lock().wait();
    }
    fn shutdown(&self) {
        self.fail("ACP session closed");
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.get_mut().kill();
        let _ = self.child.get_mut().wait();
    }
}
fn valid_permission(params: &Value) -> bool {
    params["toolCall"]["toolCallId"].is_string()
        && params["options"].as_array().is_some_and(|options| {
            !options.is_empty()
                && options.iter().all(|o| {
                    o["optionId"].is_string()
                        && o["name"].is_string()
                        && matches!(
                            o["kind"].as_str(),
                            Some("allow_once" | "allow_always" | "reject_once" | "reject_always")
                        )
                })
        })
}
fn enum_contains(schema: &Value, value: &Value) -> bool {
    schema["enum"]
        .as_array()
        .is_some_and(|items| items.contains(value))
        || schema["oneOf"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["const"] == *value))
}
fn valid_schema(schema: &Value) -> bool {
    if schema["type"] != "object" {
        return false;
    }
    let Some(properties) = schema["properties"].as_object() else {
        return false;
    };
    if schema["required"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            !item
                .as_str()
                .is_some_and(|key| properties.contains_key(key))
        })
    }) {
        return false;
    }
    properties.iter().all(|(key, p)| {
        let valid_type = match p["type"].as_str() {
            Some("string" | "number" | "integer" | "boolean") => true,
            Some("array") => {
                p["items"]["type"] == "string"
                    && (p["items"]["enum"].is_array() || p["items"]["oneOf"].is_array())
            }
            _ => false,
        };
        if !valid_type {
            return false;
        }
        // Reject schema features we cannot faithfully render/validate rather
        // than silently reinterpret an agent's requested form.
        if [
            "pattern",
            "format",
            "anyOf",
            "allOf",
            "$ref",
            "not",
            "exclusiveMinimum",
            "exclusiveMaximum",
        ]
        .iter()
        .any(|name| p.get(name).is_some())
        {
            return false;
        }
        let enum_schema = if p["type"] == "array" { &p["items"] } else { p };
        if enum_schema["enum"]
            .as_array()
            .is_some_and(|items| items.is_empty() || !items.iter().all(Value::is_string))
        {
            return false;
        }
        if enum_schema["oneOf"].as_array().is_some_and(|items| {
            items.is_empty()
                || !items
                    .iter()
                    .all(|item| item["const"].is_string() && item["title"].is_string())
        }) {
            return false;
        }
        if let Some(default) = p.get("default") {
            return validate_content(&json!({"properties":{(key):p}}), &json!({(key):default}))
                .is_ok();
        }
        true
    })
}
fn validate_content(schema: &Value, content: &Value) -> Result<(), String> {
    let values = content
        .as_object()
        .ok_or("Form content must be an object")?;
    let properties = schema["properties"]
        .as_object()
        .ok_or("Invalid form schema")?;
    if let Some(required) = schema["required"].as_array() {
        for key in required {
            if !values.contains_key(key.as_str().ok_or("Invalid required field")?) {
                return Err(format!("Required field missing: {key}"));
            }
        }
    }
    for (key, value) in values {
        let p = properties.get(key).ok_or("Unknown form field")?;
        let valid = match p["type"].as_str() {
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("number") => value.is_number(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("array") => value.as_array().is_some_and(|a| {
                a.iter().enumerate().all(|(index, v)| {
                    v.is_string() && enum_contains(&p["items"], v) && !a[..index].contains(v)
                })
            }),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid field type: {key}"));
        }
        if (p["enum"].is_array() || p["oneOf"].is_array()) && !enum_contains(p, value) {
            return Err(format!("Unknown enum value: {key}"));
        }
        if let Some(number) = value.as_f64() {
            if p["minimum"].as_f64().is_some_and(|min| number < min)
                || p["maximum"].as_f64().is_some_and(|max| number > max)
            {
                return Err(format!("Number is out of range: {key}"));
            }
        }
        if let Some(text) = value.as_str() {
            let length = text.chars().count() as u64;
            if p["minLength"].as_u64().is_some_and(|min| length < min)
                || p["maxLength"].as_u64().is_some_and(|max| length > max)
            {
                return Err(format!("Text length is out of range: {key}"));
            }
        }
        if let Some(items) = value.as_array() {
            if p["minItems"]
                .as_u64()
                .is_some_and(|min| (items.len() as u64) < min)
                || p["maxItems"]
                    .as_u64()
                    .is_some_and(|max| (items.len() as u64) > max)
            {
                return Err(format!("Selection count is out of range: {key}"));
            }
        }
    }
    Ok(())
}
fn validate_answers(params: &Value, answers: &Value) -> Result<(), String> {
    let answers = answers.as_object().ok_or("Answers must be an object")?;
    let questions = params["toolInput"]["questions"]
        .as_array()
        .ok_or("Missing questions")?;
    if answers.len() != questions.len() {
        return Err("Answer count does not match questions".into());
    }
    for (index, question) in questions.iter().enumerate() {
        let key = question["id"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("q_{index}"));
        let answer = answers.get(&key).ok_or("Missing question answer")?;
        if question["multiSelect"] == true {
            let selections = answer
                .as_array()
                .ok_or("Multiple selections must be an array")?;
            if selections.is_empty()
                || !selections.iter().all(|a| {
                    question["options"]
                        .as_array()
                        .is_some_and(|opts| opts.iter().any(|o| o["label"] == *a))
                })
            {
                return Err("Invalid multiple selection".into());
            }
        } else if !answer.as_str().is_some_and(|a| !a.trim().is_empty()) {
            return Err("Answer must be a nonempty string".into());
        }
    }
    Ok(())
}
