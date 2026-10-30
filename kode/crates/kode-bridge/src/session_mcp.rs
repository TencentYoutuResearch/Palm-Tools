//! Session-scoped STDIO access for GUI-launched CLIs. The owner credential is
//! used only to bootstrap a scoped token and never appears in a tool response.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
        Ok(tool_definitions()
            .into_iter()
            .filter(|tool| {
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
            .collect())
    }
    async fn execute(&self, name: &str, args: Value) -> Result<Value> {
        if !self.tools().await?.iter().any(|tool| tool["name"] == name) {
            bail!("This capability is disabled in Kode settings")
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
                }Ok(result)
            },
            "kode_sessions_send"=>self.call("messages",Some(json!({"target":{"node_id":args["node_id"],"session_id":args["session_id"]},"content":args["content"],"idempotency_key":args["idempotency_key"],"in_reply_to":args["in_reply_to"]}))).await,
            "kode_sessions_read"|"kode_sessions_wait"=>{
                let after=args["after"].as_u64().unwrap_or(0);let duration=if name.ends_with("wait"){args["timeout_seconds"].as_u64().unwrap_or(15).clamp(1,30)}else{0};
                let until=tokio::time::Instant::now()+Duration::from_secs(duration);
                loop{let result=self.call(&format!("events?after={after}"),None).await?;if result["events"].as_array().is_some_and(|rows|!rows.is_empty()) || tokio::time::Instant::now()>=until{return Ok(result)};tokio::time::sleep(Duration::from_millis(250)).await;}
            },
            _=>bail!("Unknown session tool"),
        }
    }
}

fn definition(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","additionalProperties":false,"properties":properties,"required":required}})
}
fn tool_definitions() -> Vec<Value> {
    vec![
    definition("kode_sessions_list","Find local and SSH conversations by name. Inspect matches before sending; never guess addresses.",json!({"query":{"type":"string"}}),&[]),
    definition("kode_sessions_send","Send a request or reply to another conversation. Delivery is not task completion. Reuse idempotency_key only for a retry; reply with in_reply_to.",json!({"node_id":{"type":"string"},"session_id":{"type":"string"},"content":{"type":"string"},"idempotency_key":{"type":"string"},"in_reply_to":{"type":"string"}}),&["node_id","session_id","content","idempotency_key"]),
    definition("kode_sessions_read","Read this conversation's message and receipt events after a durable cursor.",json!({"after":{"type":"integer","minimum":0}}),&[]),
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
            if method=="tools/list"{return Ok(json!({"tools":client.tools().await?}))}
            if method=="tools/call"{
                let result=client.execute(request["params"]["name"].as_str().unwrap_or_default(),request["params"]["arguments"].clone()).await;
                return Ok(match result{Ok(value)=>json!({"content":[{"type":"text","text":value.to_string()}]}),Err(error)=>json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]})})
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
