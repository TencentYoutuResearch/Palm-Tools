//! 最小 MCP stdio server,暴露 memory 工具。
//!
//! v1 设计(`.specops/specs/memory-design.md` §5):
//! - `memory_search` / `memory_read` / `memory_propose` / `memory_list_recent` —— agent 可调
//! - `memory_list_pending` / `memory_review` / `memory_deprecate` —— 仅用户可调(由 UI 转发)
//!
//! prototype 阶段 server 不区分调用方;真正区分由前端 UI / 工具白名单决定。
//! 但**移除了原 prototype 的 `memory_write`**(违反"提议+审核"模型)。
//!
//! 启动:
//! ```text
//! KODE_MEMORY_ROOT=/tmp/kode-mem cargo run -p kode-memory --bin kode-memory-mcp
//! ```

use anyhow::{Context, Result};
use kode_memory::{
    budget::{
        BudgetError, BudgetStore, COST_PROPOSE, PENALTY_BLACKLIST, PENALTY_REJECT, REWARD_APPROVE,
    },
    store::{ProposeResult, ReviewOutcome, Verdict},
    Kind, MemoryStore, Scope,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// Codex reads this during MCP initialization. Keep the local-only trust boundary and
/// the read/write split self-contained in the first 512 characters: approval reviewers
/// may otherwise infer that "shared memory" means a remote data sink.
const SERVER_INSTRUCTIONS: &str = "Kode Memory is a local-only STDIO MCP server. It reads and writes only files under the local KODE_MEMORY_ROOT directory, makes no network requests, and never sends data to third parties. memory_search, memory_read, memory_list_recent, memory_list_pending, and memory_budget_status are read-only and idempotent. memory_propose only creates a local pending proposal; it does not publish a searchable fact until user review. memory_review and memory_deprecate are user-only local write operations. No tool has open-world access.";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let root = match std::env::var("KODE_MEMORY_ROOT") {
        Ok(v) => std::path::PathBuf::from(v),
        Err(_) => dirs::home_dir()
            .context("no home dir")?
            .join(".kode-memory"),
    };
    eprintln!("[kode-memory-mcp] root = {}", root.display());

    let store = Arc::new(Mutex::new(MemoryStore::open(&root)?));
    let budget = Arc::new(Mutex::new(BudgetStore::open(&root)?));

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();
    let mut writer = stdout;

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[kode-memory-mcp] parse error: {}", e);
                continue;
            }
        };
        let id = req.get("id").cloned();
        let method = req
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let params = req.get("params").cloned().unwrap_or(json!({}));

        let response = match handle(&method, params, &store, &budget).await {
            Ok(Some(result)) => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            })),
            Ok(None) => None,
            Err(e) => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": e.to_string() },
            })),
        };

        if let Some(resp) = response {
            let s = serde_json::to_string(&resp)?;
            writer.write_all(s.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

async fn handle(
    method: &str,
    params: Value,
    store: &Arc<Mutex<MemoryStore>>,
    budget: &Arc<Mutex<BudgetStore>>,
) -> Result<Option<Value>> {
    match method {
        "initialize" => Ok(Some(json!({
            "protocolVersion": "2024-11-05",
            "serverInfo": { "name": "kode-memory", "version": "0.1.0" },
            "capabilities": { "tools": {} },
            "instructions": SERVER_INSTRUCTIONS
        }))),
        "notifications/initialized" | "notifications/cancelled" => Ok(None),
        "tools/list" => Ok(Some(json!({ "tools": tool_specs() }))),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("tools/call missing name"))?;
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let out = call_tool(name, args, store, budget).await?;
            Ok(Some(json!({
                "content": [{ "type": "text", "text": out }]
            })))
        }
        _ => Err(anyhow::anyhow!("unknown method: {}", method)),
    }
}

fn tool_specs() -> Value {
    json!([
        {
            "name": "memory_search",
            "description": "Search the shared memory pool for prior facts (project conventions, gotchas, user preferences, dead-ends). Returns top-k hits with snippets. \
    CALL THIS BEFORE answering: any question about project conventions / coding style / UI policy / naming rules; any module-modification task (search the module name to find 'don't touch X' constraints); any debugging task (search the error message and module name); any 'why is it like this' question. \
    Treat hits as working assumptions — they save 30+ min per match. If a hit clearly contradicts current observation, propose a replacement with `memory_propose(supersedes=<id>)` instead of silently overriding.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Keywords (Chinese or English). Try multiple angles if first search misses — module name, error text, user's own phrasing."},
                    "scope": {"type": "string", "description": "Limit to 'project:<slug>' (current project) or 'shared' (cross-project). Omit to search all scopes."},
                    "top_k": {"type": "integer", "default": 10}
                },
                "required": ["query"]
            },
            "annotations": read_only_annotations("Search local memory")
        },
        {
            "name": "memory_read",
            "description": "Read a fact's full content by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": {"type": "string"} },
                "required": ["id"]
            },
            "annotations": read_only_annotations("Read a local memory fact")
        },
        {
            "name": "memory_propose",
            "description": "Propose a new fact for the shared memory pool. Goes to a pending queue and is NOT searchable until the user approves it. Costs 1 energy point per call (auto-throttle: rejected proposals cost more, see memory_budget_status). \
    USE WHEN you discover: (1) a gotcha that would waste 30+ min for the next person, (2) a project-level architectural constraint that doesn't fit in code comments, (3) a cross-session user preference or decision. \
    DO NOT USE for: single-task TODOs (use TaskCreate), generic programming knowledge, your own thinking trace, or unverified guesses. \
    ALWAYS run memory_search with the same tags/keywords first — if a duplicate exists skip; if a near-match needs revision use `supersedes=<old_id>` instead of creating a parallel fact. \
    \n\nDUPLICATE HANDLING: when this call returns `error=\"duplicate\"`, you'll get a top-K `candidates` array. Decide based on its content, NOT on the bare similarity number: \
    \n  • Top candidate is the SAME rule restated → skip propose, the rule already exists. \
    \n  • Top candidate is OUTDATED / WRONG → re-call with `supersedes=<that id>` (it will replace, not duplicate). \
    \n  • Candidates are DIFFERENT rules that happen to share words (the embedding can't tell short rule-like sentences apart) → re-call with `force=true`. This is the right move when the rule is independently useful and would not contradict the existing one. \
    \n  • Unsure → present the top candidate snippet to the user and ask which path to take. \
    \nDefault `scope` to 'project:<current-slug>'. Only use 'shared' when the fact is OBVIOUSLY cross-project (e.g. tooling defaults). \
    \n\nALWAYS set `kind` to match the knowledge type — do NOT leave everything as the default `gotcha`. Pick: `invariant` for a must-hold constraint, `recipe` for standard steps to do X, `dead_end` for a tried-and-failed approach (record what/why/use_instead), `preference` for a user preference, `gotcha` only for a genuine trap/surprise. \
    Also set `title` when possible so Obsidian filenames get a readable slug; the store will derive a fallback from tags/body if omitted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "author": {"type": "string", "description": "Your backend name (codebuddy / claude / claude-internal). The injected system prompt tells you which one you are."},
                    "scope": {"type": "string", "description": "'project:<slug>' (default for project-specific facts) or 'shared' (only for cross-project knowledge). Never default to shared when uncertain."},
                    "kind": {"type": "string", "enum": ["gotcha", "invariant", "recipe", "dead_end", "preference"], "description": "Knowledge type. CHOOSE deliberately — don't default everything to gotcha. invariant=must-hold constraint, recipe=standard steps, dead_end=tried&failed approach, preference=user preference, gotcha=genuine trap/surprise. Defaults to gotcha if omitted."},
                    "body": {"type": "string", "description": "One sentence conclusion + one sentence why. Max 5 lines. Concrete > abstract."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "1-4 tags covering module + action/symptom + qualifier (platform/version). Used by future searches to find this fact."},
                    "supersedes": {"type": "string", "description": "Old fact id to REPLACE (the old fact will be marked deprecated when this proposal is approved). Use when a near-match needs revision rather than parallel co-existence."},
                    "force": {"type": "boolean", "description": "If true, skip the FTS-based near-duplicate check (candidate review is your responsibility). Use ONLY after the previous attempt returned `error=duplicate` AND you reviewed the `candidates` array AND confirmed they describe DIFFERENT rules that just happen to share vocabulary. The exact-duplicate check (normalized body) still runs and is not bypassed.", "default": false},
                    "confidence": {"type": "number", "description": "0.0-1.0. Use 0.5 for unverified hypotheses and explain assumption in rationale."},
                    "session": {"type": "string"},
                    "rationale": {"type": "string", "description": "Why this is worth remembering. Shown to the human reviewer — be specific about evidence."},
                    "title": {"type": "string", "description": "Short human-readable title (max 80 chars, kebab-case auto-derived for Obsidian filename). If omitted, the store derives a fallback title from tags/body; only all-non-ASCII/empty inputs fall back to bare ULID."}
                },
                "required": ["author", "scope", "body"]
            },
            "annotations": local_write_annotations("Propose a local memory fact", false)
        },
        {
            "name": "memory_list_recent",
            "description": "List facts created in the last N hours (default 24).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "scope": {"type": "string"},
                    "since_hours": {"type": "integer", "default": 24}
                }
            },
            "annotations": read_only_annotations("List recent local memory facts")
        },
        {
            "name": "memory_list_pending",
            "description": "(user-only) List proposals awaiting review.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read_only_annotations("List local pending proposals")
        },
        {
            "name": "memory_review",
            "description": "(user-only) Review a pending proposal. Verdict: approve | edit_then_approve | reject | blacklist.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["approve", "edit_then_approve", "reject", "blacklist"]},
                    "edited_body": {"type": "string"},
                    "edited_tags": {"type": "array", "items": {"type": "string"}},
                    "edited_scope": {"type": "string"},
                    "edited_confidence": {"type": "number"},
                    "related": {"type": "array", "items": {"type": "string"}},
                    "contradicts": {"type": "array", "items": {"type": "string"}},
                    "title": {"type": "string"},
                    "reason": {"type": "string"}
                },
                "required": ["id", "verdict"]
            },
            "annotations": local_write_annotations("Review a local memory proposal", true)
        },
        {
            "name": "memory_deprecate",
            "description": "(user-only) Soft-delete a fact with a reason. Agents wanting to invalidate an existing fact must use memory_propose with supersedes instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "reason": {"type": "string"}
                },
                "required": ["id", "reason"]
            },
            "annotations": local_write_annotations("Deprecate a local memory fact", true)
        },
        {
            "name": "memory_budget_status",
            "description": "Get current energy for an author. Useful for agents to self-throttle.",
            "inputSchema": {
                "type": "object",
                "properties": { "author": {"type": "string"} },
                "required": ["author"]
            },
            "annotations": read_only_annotations("Read local memory budget status")
        }
    ])
}

fn read_only_annotations(title: &str) -> Value {
    json!({
        "title": title,
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
    })
}

fn local_write_annotations(title: &str, destructive: bool) -> Value {
    json!({
        "title": title,
        "readOnlyHint": false,
        "destructiveHint": destructive,
        "idempotentHint": false,
        "openWorldHint": false
    })
}

async fn call_tool(
    name: &str,
    args: Value,
    store: &Arc<Mutex<MemoryStore>>,
    budget: &Arc<Mutex<BudgetStore>>,
) -> Result<String> {
    match name {
        "memory_search" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let scope = args.get("scope").and_then(|v| v.as_str());
            let top_k = args.get("top_k").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            let s = store.lock().await;
            let hits = s.search(q, scope, top_k, false)?;
            Ok(serde_json::to_string_pretty(&hits)?)
        }
        "memory_read" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing id"))?;
            let s = store.lock().await;
            let f = s.read(id)?;
            Ok(json!({ "meta": &f.meta, "body": &f.body }).to_string())
        }
        "memory_propose" => handle_propose(args, store, budget).await,
        "memory_list_recent" => {
            let scope = args.get("scope").and_then(|v| v.as_str());
            let hours = args
                .get("since_hours")
                .and_then(|v| v.as_u64())
                .unwrap_or(24);
            let s = store.lock().await;
            let hits = s.list_recent(scope, hours)?;
            Ok(serde_json::to_string_pretty(&hits)?)
        }
        "memory_list_pending" => {
            let s = store.lock().await;
            let p = s.list_pending()?;
            Ok(serde_json::to_string_pretty(&p)?)
        }
        "memory_review" => handle_review(args, store, budget).await,
        "memory_deprecate" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing id"))?;
            let reason = args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("(no reason)");
            let mut s = store.lock().await;
            s.deprecate(id, reason)?;
            Ok(json!({ "ok": true }).to_string())
        }
        "memory_budget_status" => {
            let author = args
                .get("author")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("missing author"))?;
            let mut b = budget.lock().await;
            let energy = b.current_energy(author);
            Ok(json!({ "author": author, "energy": energy, "max": 5.0 }).to_string())
        }
        _ => Err(anyhow::anyhow!("unknown tool: {}", name)),
    }
}

async fn handle_propose(
    args: Value,
    store: &Arc<Mutex<MemoryStore>>,
    budget: &Arc<Mutex<BudgetStore>>,
) -> Result<String> {
    let author = args
        .get("author")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing author"))?;
    let scope_str = args
        .get("scope")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing scope"))?;
    let scope = Scope::parse(scope_str)?;
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing body"))?;
    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let supersedes = args
        .get("supersedes")
        .and_then(|v| v.as_str())
        .map(String::from);
    let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let confidence = args
        .get("confidence")
        .and_then(|v| v.as_f64())
        .map(|f| f as f32);
    let session = args.get("session").and_then(|v| v.as_str());
    let rationale = args
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(String::from);
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(Kind::parse)
        .transpose()?;
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 1. 先扣能量(扣不下来直接返回)
    let mut b = budget.lock().await;
    let remaining = match b.try_charge(author, COST_PROPOSE) {
        Ok(r) => r,
        Err(BudgetError::OutOfEnergy {
            current,
            needed,
            next_refill_at,
        }) => {
            return Ok(json!({
                "error": "out_of_energy",
                "current": current,
                "needed": needed,
                "next_refill_at": next_refill_at,
                "message": "Energy depleted. Wait for refill or improve your proposal acceptance rate."
            })
            .to_string());
        }
        Err(other) => return Err(anyhow::anyhow!("{}", other)),
    };
    drop(b); // 释放锁后再操作 store

    // 2. 写 pending
    let mut s = store.lock().await;
    let result = s.propose(
        author, session, scope, body, tags, supersedes, confidence, rationale, force, kind, title,
    )?;

    Ok(match result {
        ProposeResult::Accepted { id } => json!({
            "ok": true,
            "id": id,
            "energy_remaining": remaining,
            "status": "pending_review"
        }),
        ProposeResult::Duplicate(info) => {
            // 退还扣费 —— 重复不算消耗
            drop(s);
            let mut b = budget.lock().await;
            let _ = b.add(author, COST_PROPOSE);
            json!({
                "error": "duplicate",
                "existing_id": info.existing_id,
                "similarity": info.similarity,
                "snippet": info.snippet,
                "candidates": info.candidates,
                "message": "Near-duplicate detected. Review `candidates` and decide: \
                    (a) skip if a candidate is the same rule, \
                    (b) re-call with `supersedes=<id>` to replace one, \
                    (c) re-call with `force=true` if all candidates are different rules that just share vocabulary."
            })
        }
        ProposeResult::BodyTooLong { len, max } => {
            drop(s);
            let mut b = budget.lock().await;
            let _ = b.add(author, COST_PROPOSE);
            json!({
                "error": "body_too_long",
                "len": len,
                "max": max,
                "message": "Body too long. Split into multiple smaller facts."
            })
        }
    }
    .to_string())
}

async fn handle_review(
    args: Value,
    store: &Arc<Mutex<MemoryStore>>,
    budget: &Arc<Mutex<BudgetStore>>,
) -> Result<String> {
    let id = args
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing id"))?;
    let verdict_str = args
        .get("verdict")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing verdict"))?;

    let verdict = match verdict_str {
        "approve" => Verdict::Approve,
        "edit_then_approve" => Verdict::EditThenApprove {
            body: args
                .get("edited_body")
                .and_then(|v| v.as_str())
                .map(String::from),
            tags: args.get("edited_tags").and_then(|v| v.as_array()).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            }),
            scope: args
                .get("edited_scope")
                .and_then(|v| v.as_str())
                .map(Scope::parse)
                .transpose()?,
            confidence: args
                .get("edited_confidence")
                .and_then(|v| v.as_f64())
                .map(|f| f as f32),
            related: args.get("related").and_then(|v| v.as_array()).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            }),
            contradicts: args.get("contradicts").and_then(|v| v.as_array()).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            }),
            title: args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        },
        "reject" => Verdict::Reject {
            reason: args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("(no reason)")
                .to_string(),
        },
        "blacklist" => Verdict::Blacklist {
            reason: args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("(no reason)")
                .to_string(),
        },
        other => return Err(anyhow::anyhow!("invalid verdict: {}", other)),
    };

    // 先读出 author(为后续 budget 联动用)
    let s = store.lock().await;
    let pending = s.read_pending(id)?;
    let author = pending.meta.author.clone();
    drop(s);

    let mut s = store.lock().await;
    let outcome = s.review(id, verdict)?;
    drop(s);

    // 联动 budget
    let mut b = budget.lock().await;
    match outcome {
        ReviewOutcome::Approved => {
            let _ = b.add(&author, REWARD_APPROVE);
        }
        ReviewOutcome::Rejected => {
            let _ = b.penalize(&author, PENALTY_REJECT);
        }
        ReviewOutcome::Blacklisted => {
            let _ = b.penalize(&author, PENALTY_BLACKLIST);
        }
    }
    let energy_after = b.current_energy(&author);

    Ok(json!({
        "ok": true,
        "outcome": match outcome {
            ReviewOutcome::Approved => "approved",
            ReviewOutcome::Rejected => "rejected",
            ReviewOutcome::Blacklisted => "blacklisted",
        },
        "author": author,
        "energy_after": energy_after
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_instructions_lead_with_local_only_boundary() {
        let prefix: String = SERVER_INSTRUCTIONS.chars().take(512).collect();
        assert!(prefix.contains("local-only STDIO MCP server"));
        assert!(prefix.contains("KODE_MEMORY_ROOT"));
        assert!(prefix.contains("makes no network requests"));
        assert!(prefix.contains("never sends data to third parties"));
        assert!(prefix.contains("read-only and idempotent"));
    }

    #[test]
    fn tool_annotations_describe_read_write_and_network_behavior() {
        let specs = tool_specs();
        let tools = specs.as_array().expect("tool_specs must return an array");

        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let annotations = &tool["annotations"];
            assert_eq!(annotations["openWorldHint"], false, "{name}");
            assert!(annotations["readOnlyHint"].is_boolean(), "{name}");
            assert!(annotations["destructiveHint"].is_boolean(), "{name}");
            assert!(annotations["idempotentHint"].is_boolean(), "{name}");
        }

        let search = tools
            .iter()
            .find(|tool| tool["name"] == "memory_search")
            .unwrap();
        assert_eq!(search["annotations"]["readOnlyHint"], true);
        assert_eq!(search["annotations"]["idempotentHint"], true);

        let propose = tools
            .iter()
            .find(|tool| tool["name"] == "memory_propose")
            .unwrap();
        assert_eq!(propose["annotations"]["readOnlyHint"], false);
        assert_eq!(propose["annotations"]["destructiveHint"], false);

        let deprecate = tools
            .iter()
            .find(|tool| tool["name"] == "memory_deprecate")
            .unwrap();
        assert_eq!(deprecate["annotations"]["destructiveHint"], true);
    }
}
