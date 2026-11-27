//! Session-scoped STDIO access for GUI-launched CLIs. The owner credential is
//! used only to bootstrap a scoped token and never appears in a tool response.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

mod pages;

struct Client {
    http: reqwest::Client,
    origin: String,
    token: String,
}
impl Client {
    async fn call(&self, path: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}/api/v1/messaging/{path}", self.origin);
        let request = if let Some(body) = body {
            self.http.post(url).json(&body)
        } else {
            self.http.get(url)
        };
        let response = request.bearer_auth(&self.token).send().await?;
        let status = response.status();
        let value: Value = response.json().await?;
        if !status.is_success() {
            bail!(
                "{}",
                value["error"]
                    .as_str()
                    .unwrap_or("Kode backend unavailable")
            )
        };
        Ok(value)
    }
    async fn owner() -> Result<Self> {
        let path = std::env::var_os("KODE_WORKBENCH_CONNECTION")
            .map(PathBuf::from)
            .or_else(|| dirs::config_dir().map(|p| p.join("kode/workbench-connection.json")))
            .context("Kode backend connection unavailable")?;
        let connection: Value = serde_json::from_slice(&tokio::fs::read(path).await?)?;
        let origin = connection["url"]
            .as_str()
            .context("Missing backend URL")?
            .trim_end_matches('/')
            .to_owned();
        let url = url::Url::parse(&origin)?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            bail!("Shared session MCP requires an authenticated loopback backend")
        }
        let owner = tokio::fs::read_to_string(
            connection["token_file"]
                .as_str()
                .context("Missing backend credential file")?,
        )
        .await?;
        let client = Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(35))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            origin,
            token: owner.trim().into(),
        };
        Ok(client)
    }
    async fn bootstrap() -> Result<Self> {
        let mut client = Self::owner().await?;
        let native_id: u64 = std::env::var("KODE_SESSION_ID")?.parse()?;
        let process_id: u64 = std::env::var("KODE_GUI_PROCESS_ID")?.parse()?;
        let mut last = None;
        for _ in 0..40 {
            match client
                .call(
                    "native/resolve",
                    Some(json!({"native_id":native_id,"process_id":process_id})),
                )
                .await
            {
                Ok(value) => {
                    client.token = value["token"]
                        .as_str()
                        .context("Missing session credential")?
                        .into();
                    client.call("self", None).await?;
                    return Ok(client);
                }
                Err(error) => last = Some(error),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(last.context("GUI session did not register")?)
    }
    async fn tools(&self) -> Result<Vec<Value>> {
        let settings = self.call("integrations", None).await?;
        let capabilities = self.call("node", None).await?;
        // Tools extensions contribute to this session; an older backend has none.
        let contributed: Vec<Value> = self
            .call("extensions/tools", None)
            .await
            .map(|value| value["tools"].as_array().cloned().unwrap_or_default())
            .unwrap_or_default()
            .into_iter()
            .map(|tool| json!({"name":tool["name"],"description":tool["description"],"inputSchema":tool["inputSchema"],"x-kode-extension":true}))
            .collect();
        let orchestration: Vec<Value> = if settings["messaging_enabled"] == true {
            self.call("session-tools", None)
                .await
                .map(|value| value["tools"].as_array().cloned().unwrap_or_default())
                .unwrap_or_default()
                .into_iter()
                .map(|tool| json!({"name":tool["name"],"description":tool["description"],"inputSchema":tool["inputSchema"],"x-kode-session-tool":true}))
                .collect()
        } else {
            vec![]
        };
        let builtin: Vec<Value> = tool_definitions(capabilities["message_titles"] == true, capabilities["queued_messages"] == true)
            .into_iter()
            .filter(|tool| {
                if matches!(tool["name"].as_str(), Some("kode_sessions_cancel_input" | "kode_sessions_cancellation_status")) && capabilities["input_cancellation"] != true { return false; }

                if tool["name"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("memory_")
                {
                    settings["memory_enabled"] == true
                } else {
                    settings["messaging_enabled"] == true
                }
            })
            .collect();
        Ok(builtin.into_iter().chain(orchestration).chain(contributed).collect())
    }
    async fn execute(&self, name: &str, args: Value) -> Result<Value> {
        let tools = self.tools().await?;
        let Some(tool) = tools.iter().find(|tool| tool["name"] == name) else {
            bail!("This capability is disabled in Kode settings")
        };
        if tool["x-kode-session-tool"] == true {
            return self
                .call("session-tools/call", Some(json!({"name":name,"arguments":args})))
                .await;
        }
        if tool["x-kode-extension"] == true {
            let result = self.call("extensions/tools/call", Some(json!({"name":name,"arguments":args}))).await?;
            let text = result["text"].as_str().unwrap_or_default().to_owned();
            if result["is_error"] == true {
                bail!("{text}")
            }
            // Extension results are already text for the model.
            return Ok(Value::String(text));
        }
        if name.starts_with("memory_") {
            return self
                .call("memory/tool", Some(json!({"name":name,"arguments":args})))
                .await;
        }
        match name {
            "kode_sessions_list"=>{
                let mut result=self.call("sessions",None).await?;
                if let Some(query)=args["query"].as_str().map(|q|q.trim().to_lowercase()).filter(|q|!q.is_empty()){
                    if let Some(rows)=result["sessions"].as_array_mut(){rows.retain(|row|format!("{} {}",row["title"].as_str().unwrap_or_default(),row["address"]).to_lowercase().contains(&query));}
                }
                if let Ok(catalog)=self.call("session-tools/catalog",None).await {
                    for key in ["workspaces","agentConfigurations","sessionNaming"] {
                        if !catalog[key].is_null() { result[key]=catalog[key].clone(); }
                    }
                }
                Ok(result)
            },
            "kode_sessions_send" => {
                let mut body = json!({
                    "target":{"node_id":args["node_id"],"session_id":args["session_id"]},
                    "content":args["content"],"idempotency_key":args["idempotency_key"],"in_reply_to":args["in_reply_to"]
                });
                if let Some(interrupt) = args.get("interrupt") { body["interrupt"] = interrupt.clone(); }
                if let Some(title) = args.get("title").filter(|_| tool["inputSchema"]["properties"].get("title").is_some()) {
                    body["title"] = title.clone();
                }
                self.call("messages", Some(body)).await
            },
            "kode_sessions_delivery_status"|"kode_sessions_cancel_input"|"kode_sessions_cancellation_status"=>{
                let id=args["message_id"].as_str().ok_or_else(||anyhow::anyhow!("Message ID required"))?;
                if !crate::messaging::model::valid_id(id) { bail!("Invalid message ID") }
                let suffix=if name=="kode_sessions_delivery_status"{"delivery"}else{"cancellation"};
                let body=if name=="kode_sessions_cancel_input"{Some(json!({}))}else{None};
                self.call(&format!("messages/{id}/{suffix}"),body).await
            },
            "kode_sessions_message_read"=>{
                let id=args["message_id"].as_str().ok_or_else(||anyhow::anyhow!("Message ID required"))?;
                if !crate::messaging::model::valid_id(id) { bail!("Invalid message ID") }
                let offset=if args["offset"].is_null(){0}else{args["offset"].as_u64().ok_or_else(||anyhow::anyhow!("Offset must be a nonnegative code-point index"))?};
                pages::message(self.call(&format!("messages/{id}"),None).await?,offset)
            },
            "kode_sessions_read"|"kode_sessions_wait"=>{
                let after=args["after"].as_u64().unwrap_or(0);let duration=if name.ends_with("wait"){args["timeout_seconds"].as_u64().unwrap_or(15).clamp(1,30)}else{0};
                let until=tokio::time::Instant::now()+Duration::from_secs(duration);
                // The backend holds the request open until an event arrives.
                loop{let wait=until.saturating_duration_since(tokio::time::Instant::now()).as_secs();let result=self.call(&format!("events?after={after}&wait={wait}"),None).await?;if result["events"].as_array().is_some_and(|rows|!rows.is_empty()) || tokio::time::Instant::now()>=until{return pages::events(result,after)};tokio::time::sleep(Duration::from_millis(250)).await;}
            },
            _=>bail!("Unknown session tool"),
        }
    }
}

fn definition(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","additionalProperties":false,"properties":properties,"required":required}})
}
fn tool_definitions(message_titles: bool, queued_messages: bool) -> Vec<Value> {
    let mut send_properties = json!({
        "node_id":{"type":"string"},"session_id":{"type":"string"},"content":{"type":"string"},
        "idempotency_key":{"type":"string"},"in_reply_to":{"type":"string"}
    });
    let mut send_description = "Send a request or reply to another conversation. Delivery is not task completion. Reuse idempotency_key only for a retry; reply with in_reply_to.".to_owned();
    if queued_messages {
        send_properties["interrupt"] = json!({"type":"boolean","description":"Set false to queue until the recipient finishes its current turn. Defaults to true."});
    }
    if message_titles {
        send_description.push_str(" Write a concise title and put the description in content.");
        send_properties["title"] = json!({
            "type":"string","minLength":1,"maxLength":crate::messaging::model::MAX_TITLE_CHARS,
            "description":"Write a concise, single-line subject for the request or reply. Put the details in content."
        });
    }
    vec![
    definition("kode_sessions_list","Find local and SSH conversations by name, plus workspaces, enabled agents, and sessionNaming policy for kode_sessions_create. Inspect matches before sending; never guess addresses.",json!({"query":{"type":"string"}}),&[]),
    definition("kode_sessions_send",&send_description,send_properties,&["node_id","session_id","content","idempotency_key"]),
    definition("kode_sessions_message_read","Read authenticated full-message pages. Offset counts Unicode code points; follow next until null. A preview is not proof of consumption.",json!({"message_id":{"type":"string"},"offset":{"type":"integer","minimum":0}}),&["message_id"]),
    definition("kode_sessions_delivery_status","Read persisted input delivery evidence. Queued is not consumed; consumed is not task completion.",json!({"message_id":{"type":"string"}}),&["message_id"]),
    definition("kode_sessions_cancel_input","Request cancellation of your own message. Queue removal is not proof of stopping execution; the result may remain cancel_unconfirmed.",json!({"message_id":{"type":"string"}}),&["message_id"]),
    definition("kode_sessions_cancellation_status","Read the persisted cancellation result. A stop request does not prove termination.",json!({"message_id":{"type":"string"}}),&["message_id"]),
    definition("kode_sessions_read","Read bounded message and receipt previews. Follow cursor until empty. Use the continuation tool for truncated content.",json!({"after":{"type":"integer","minimum":0}}),&[]),
    definition("kode_sessions_wait","Wait up to 30 seconds for this conversation's messages or receipts.",json!({"after":{"type":"integer","minimum":0},"timeout_seconds":{"type":"integer","minimum":1,"maximum":30}}),&["after"]),
    definition("memory_search","Search reviewed memory on this Host's Kode backend.",json!({"query":{"type":"string"},"scope":{"type":"string"},"top_k":{"type":"integer"}}),&["query"]),
    definition("memory_read","Read one reviewed Kode memory fact and its backlinks.",json!({"id":{"type":"string"}}),&["id"]),
    definition("memory_list_recent","Read recently reviewed Kode memories.",json!({"scope":{"type":"string"},"since_hours":{"type":"integer"},"limit":{"type":"integer"}}),&[]),
    definition("memory_propose","Propose reusable knowledge to the Kode backend. It remains pending until owner review. Never include credentials.",json!({"scope":{"type":"string"},"body":{"type":"string"},"title":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"kind":{"type":"string","enum":["gotcha","invariant","recipe","dead_end","preference"]},"supersedes":{"type":"string"},"rationale":{"type":"string"},"confidence":{"type":"number"},"force":{"type":"boolean"}}),&["scope","body"]),
    definition("memory_budget_status","Read this conversation's memory proposal budget.",json!({}),&[]),
]
}

pub async fn run() -> Result<()> {
    let active = kode_memory::runtime_context::is_active(None)
        && std::env::var_os("KODE_GUI_PROCESS_ID").is_some();
    let mut client = None;
    let mut reader = BufReader::new(tokio::io::stdin()).lines();
    let mut writer = tokio::io::stdout();
    while let Some(line) = reader.next_line().await? {
        if line.len() > 128 * 1024 {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let method = request["method"].as_str().unwrap_or_default();
        let response=async {
            if method=="initialize" {return Ok(json!({"protocolVersion":request["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"kode-shared-services","version":env!("CARGO_PKG_VERSION")}}))}
            if method=="ping" {return Ok(json!({}))}
            if !active {return if method=="tools/list"{Ok(json!({"tools":[]}))}else{bail!("Session tools require a Kode-owned GUI session")}}
            if client.is_none(){client=Some(Client::bootstrap().await?)}
            let client=client.as_ref().context("Session client unavailable")?;
            if method=="tools/list"{return Ok(json!({"tools":client.tools().await?.into_iter().map(|mut tool|{ if let Some(map)=tool.as_object_mut(){map.remove("x-kode-extension");map.remove("x-kode-session-tool");} tool }).collect::<Vec<_>>()}))}
            if method=="tools/call"{
                let result=client.execute(request["params"]["name"].as_str().unwrap_or_default(),request["params"]["arguments"].clone()).await;
                return Ok(match result{Ok(value)=>json!({"content":[{"type":"text","text":match value { Value::String(text)=>text, value=>value.to_string() }}]}),Err(error)=>json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]})})
            }
            bail!("Method not found")
        }.await;
        let response = match response {
            Ok::<Value, anyhow::Error>(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error.to_string()}})
            }
        };
        writer.write_all(format!("{response}\n").as_bytes()).await?;
        writer.flush().await?;
    }
    Ok(())
}

/// Reserve the GUI identity before a CLI initializes its MCP servers. The live
/// publisher later updates this same row instead of allocating another session.
pub async fn reserve_gui_session(
    id: u64,
    backend_key: &str,
    cwd: &std::path::Path,
    model: Option<&str>,
) -> Result<()> {
    let client = Client::owner().await?;
    let pid = std::process::id();
    let publication = json!({"runtime":"gui","boot_id":format!("gui-{pid}"),"sessions":[{"session_id":format!("gui:{pid}:{id}"),"dto":{"native_runtime_id":id,"native_process_id":pid,"reserved_at":crate::now_ms(),"backend_key":backend_key,"title":"New conversation","model":model.unwrap_or(""),"status":"starting","cwd":cwd.to_string_lossy(),"tokens":{"total":0,"input":0,"output":0,"cached":0}},"events":[]}]});
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match client.call("runtime/publish", Some(publication.clone())).await {
            Ok(_) => break,
            Err(error) if error.to_string().contains("Another Host already owns this runtime")
                && tokio::time::Instant::now() < deadline => {
                // After an abrupt GUI exit the old lease can remain valid for
                // 15 seconds. Wait before spawning, preserving single ownership.
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
