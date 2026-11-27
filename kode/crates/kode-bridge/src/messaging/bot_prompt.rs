//! Unified bot launch context (`effective_prompt`), skill symlink repair, and
//! runtime-neutral session alias resolution across TUI (`gui`) and `dsh`.
use super::{
    bots::{Bot, BotSkill, Roster},
    Hub,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

const SKILL_DIRS: &[&str] = &[
    ".claude/skills",
    ".agents/skills",
    ".codebuddy/skills",
    ".cursor/skills",
];

fn tone_preset(id: &str) -> (&'static str, &'static str) {
    match id {
        "direct" => (
            "干脆利落",
            "极简高效，开门见山：先给结论、风险和下一步动作，不寒暄、不铺垫、不客套。\n能一句话讲明白绝不拆三段；对事不对人，直接给定位和建议。",
        ),
        "warm" => (
            "温和耐心",
            "语气温和耐心、真诚克制，像细心的朋友或导师，顺着用户的思路把复杂问题拆清楚。\n注意保持真实自然，不要堆砌感叹号，不要用甜腻或模板化的客服腔。",
        ),
        "humorous" => (
            "轻松风趣",
            "聊天轻松有活人感，偶尔来一句自然的小吐槽或俏皮比喻，但干正事一点不含糊。\n幽默要点到为止，绝不尬聊、不油腻、不强行玩烂梗，关键结论和风险依然清晰准确。",
        ),
        "butler" => (
            "沉稳管家",
            "沉稳周到、有分寸，习惯提前替用户考虑截止时间、边界和潜在风险。\n像经验老道的私人助理而非冰冷客服：只把真正需要用户拍板的事提炼出来，不拿琐事打扰。",
        ),
        "custom" => (
            "自定义风格",
            "严格遵循用户指定的自定义口吻要求，保持真实、自然、有活人感。",
        ),
        _ => (
            "靠谱同事",
            "语气像共事很久的靠谱同事：自然口语化的中文，平实利落，不端着也不刻意热情。\n先说重点或直接接话，两三句能讲清楚的绝不铺成长清单；觉得方案有坑或有更好做法时直接坦诚说出来。",
        ),
    }
}

pub fn tone_prompt(tone: Option<&str>, tone_note: Option<&str>) -> String {
    let id = match tone.map(str::trim) {
        Some(t @ ("colleague" | "direct" | "warm" | "humorous" | "butler" | "custom")) => t,
        _ => "colleague",
    };
    let (label, body) = tone_preset(id);
    let mut lines = vec![
        format!("沟通语气与表达风格（{label}）："),
        body.to_owned(),
        "去人机味底线：".to_owned(),
        "- 像真人搭档一样说自然口语，严禁使用典型 AI 客服套话（如「好的，我很乐意为您效劳」「作为一个AI」「以下是我的几点建议」「希望以上信息对您有所帮助」「如果您有任何问题请随时告诉我」）。".to_owned(),
        "- 平时聊天或简短答复不要动不动就甩「1. 2. 3.」大纲和加粗小标题，只有真正列复杂步骤/多条问题时才分点。".to_owned(),
        "- 不重复复述用户刚说过的话，不假装客套，直接接话干活。".to_owned(),
    ];
    if let Some(note) = tone_note.map(str::trim).filter(|s| !s.is_empty()) {
        let bounded: String = note.replace("\r\n", "\n").chars().take(400).collect();
        lines.push(format!("- 用户的额外口吻要求（优先遵守）：{bounded}"));
    }
    lines.join("\n")
}

fn connector_how_to_ask(conn: &Value, bot_name: &str) -> String {
    let kind = conn["type"].as_str().unwrap_or_default();
    let cfg = &conn["config"];
    let str_field = |k: &str| cfg[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    match kind {
        "wecom" => match str_field("chat_id") {
            Some(chat) => format!("在企业微信会话 {chat} 中发送消息即可触发"),
            None => "在已监听的企业微信会话中发送消息即可触发".into(),
        },
        "webhook" => format!(
            "POST /api/kode/bot-webhooks/{}（携带 Bearer 密钥）",
            conn["id"].as_str().unwrap_or_default()
        ),
        "github" => {
            if cfg["watch_commits"].as_bool() == Some(true) {
                if let Some(ws) = str_field("workspace") {
                    let branch = str_field("branch")
                        .map(|b| format!("（{b} 分支）"))
                        .unwrap_or_default();
                    return match str_field("repo") {
                        Some(repo) => {
                            format!("监听工作区 {ws}{branch} 的本地提交，并用本机 gh 访问 {repo}")
                        }
                        None => format!("监听工作区 {ws}{branch} 的本地提交，并用本机 gh 操作仓库"),
                    };
                }
            }
            match str_field("repo") {
                Some(repo) => format!("使用本机 gh 访问 {repo}，或通过专属 Webhook 接收 GitHub 事件"),
                None => "使用本机 gh 账号操作仓库，或通过专属 Webhook 触发".into(),
            }
        }
        "team" => {
            let room = str_field("room");
            if str_field("mode") == Some("all") {
                format!(
                    "监听团队频道{}的新消息",
                    room.map(|r| format!(" #{r}")).unwrap_or_else(|| "（全部频道）".into())
                )
            } else {
                format!(
                    "在团队频道{}中 @{bot_name}",
                    room.map(|r| format!(" #{r}")).unwrap_or_default()
                )
            }
        }
        "slack" => format!(
            "在 Slack {}提及 @{}（转发至专属 Webhook）",
            str_field("channel").map(|c| format!("#{c} ")).unwrap_or_default(),
            str_field("mention_handle").unwrap_or(bot_name)
        ),
        "discord" => format!(
            "在 Discord {}频道/子区提及 @{}（转发至专属 Webhook）",
            str_field("channel").map(|c| format!("#{c} ")).unwrap_or_default(),
            str_field("mention_handle").unwrap_or(bot_name)
        ),
        "linear" => format!(
            "在 Linear {}添加标签 {} 或转发 Webhook",
            str_field("team").map(|t| format!("{t} ")).unwrap_or_default(),
            str_field("label")
                .map(str::to_owned)
                .unwrap_or_else(|| format!("bot:{bot_name}"))
        ),
        "google" => {
            let services: Vec<&str> = cfg["services"]
                .as_array()
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .filter(|v: &Vec<&str>| !v.is_empty())
                .unwrap_or_else(|| vec!["gmail", "calendar"]);
            let joined = services.join(" / ");
            match str_field("schedule_cron") {
                Some(cron) => format!("按定时（{cron}）自动检查 {joined}"),
                None => format!("通过本机 MCP 或专属 Webhook 触发 {joined}"),
            }
        }
        "mcp" => {
            let name = conn["name"].as_str().unwrap_or("MCP");
            match str_field("url") {
                Some(url) => format!("直接通过 MCP 地址 {url} 调用 {name} 工具"),
                None => format!("通过已配置的 MCP 服务器调用 {name}"),
            }
        }
        _ => String::new(),
    }
}

pub fn connectors_prompt(connectors_doc: &Value, bot_id: &str, bot_name: &str) -> String {
    let Some(list) = connectors_doc
        .pointer("/value/connectors")
        .or_else(|| connectors_doc.get("connectors"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    let active: Vec<&Value> = list
        .iter()
        .filter(|row| {
            row["bot_id"].as_str() == Some(bot_id) && row["enabled"].as_bool() != Some(false)
        })
        .collect();
    if active.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "你当前已启用的连接器与外部应用（需要时主动使用或按以下入口协同）：".to_owned(),
    ];
    for conn in active {
        let name = conn["name"].as_str().unwrap_or("连接器");
        let kind = conn["type"].as_str().unwrap_or("custom");
        let how = conn["how_to_ask"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| connector_how_to_ask(conn, bot_name));
        let note = if kind == "mcp" {
            conn["config"]["notes"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|n| format!("；备注：{n}"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        lines.push(format!("- {name}（{kind}）：{how}{note}"));
    }
    lines.join("\n")
}

/// Complete system prompt for a bot across all runtimes (`gui` TUI, `dsh`, watches):
/// persona + collaboration/task-board protocol + voice style + active connectors.
pub fn effective_prompt(hub: &Hub, bot: &Bot) -> String {
    let voices = hub.store.document("bot-voice").unwrap_or_default();
    let connectors = hub.store.document("bot-connectors").unwrap_or_default();
    effective_prompt_from_docs(bot, &voices, &connectors)
}

pub fn effective_prompt_from_docs(bot: &Bot, voices_doc: &Value, connectors_doc: &Value) -> String {
    let voice_entry = voices_doc
        .pointer(&format!("/value/voices/{}", bot.id))
        .or_else(|| voices_doc.pointer(&format!("/voices/{}", bot.id)));
    let tone = voice_entry.and_then(|v| v["tone"].as_str());
    let tone_note = voice_entry.and_then(|v| v["tone_note"].as_str());
    let parts = [
        bot.persona_prompt(),
        tone_prompt(tone, tone_note),
        connectors_prompt(connectors_doc, &bot.id, &bot.name),
    ];
    parts
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Ensure stored skills under `<home>/.kode/skills/<slug>` are linked into every
/// CLI's project skill directory so GUI/TUI launches load the same skills as DSH.
pub fn repair_bot_skill_links(home: &Path, skills: &[BotSkill]) {
    for skill in skills {
        if skill.slug.is_empty() || skill.slug.starts_with('.') || skill.slug.contains('/') || skill.slug.contains('\\') {
            continue;
        }
        let stored = home.join(".kode/skills").join(&skill.slug);
        if !stored.is_dir() {
            continue;
        }
        for rel_dir in SKILL_DIRS {
            let dir = home.join(rel_dir);
            if std::fs::create_dir_all(&dir).is_err() {
                continue;
            }
            let link = dir.join(&skill.slug);
            let target = Path::new("../../.kode/skills").join(&skill.slug);
            match std::fs::symlink_metadata(&link) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    if std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()) {
                        continue;
                    }
                    let _ = std::fs::remove_file(&link);
                }
                Ok(_) => continue, // Keep user-created non-symlink folder untouched.
                Err(_) => {}
            }
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(&target, &link);
            #[cfg(windows)]
            let _ = std::os::windows::fs::symlink_dir(&target, &link);
        }
    }
}

fn link_pair(graph: &mut HashMap<String, HashSet<String>>, a: Option<&str>, b: Option<&str>) {
    let (Some(a), Some(b)) = (a.filter(|s| !s.is_empty()), b.filter(|s| !s.is_empty())) else {
        return;
    };
    if a == b {
        return;
    }
    graph.entry(a.to_owned()).or_default().insert(b.to_owned());
    graph.entry(b.to_owned()).or_default().insert(a.to_owned());
}

/// Bidirectional session identity graph linking `dsh_session_id`, native CLI
/// `session_uuid` / `native_thread_id`, `runtime_session_id`, and `kode:runtime:gui:<id>`.
pub fn build_session_aliases(
    index_doc: &Value,
    snapshots: &[Value],
) -> HashMap<String, HashSet<String>> {
    let mut graph: HashMap<String, HashSet<String>> = HashMap::new();
    let idx = index_doc.get("value").unwrap_or(index_doc);
    for ptr in ["/native_sessions", "/gui/tabs"] {
        if let Some(rows) = idx.pointer(ptr).and_then(Value::as_array) {
            for row in rows {
                let ep_local = match row.get("endpoint_id") {
                    None | Some(Value::Null) => true,
                    Some(ep) => ep.get("kind").and_then(Value::as_str).unwrap_or("local") == "local",
                };
                if !ep_local {
                    continue;
                }
                link_pair(
                    &mut graph,
                    row["session_id"].as_str(),
                    row["dsh_session_id"].as_str(),
                );
            }
        }
    }
    for snap in snapshots {
        let dto = snap.get("dto").unwrap_or(snap);
        let rsid = dto["runtime_session_id"].as_str();
        let uuid = dto["session_uuid"].as_str();
        let ntid = dto["native_thread_id"].as_str();
        link_pair(&mut graph, rsid, uuid);
        link_pair(&mut graph, rsid, ntid);
        link_pair(&mut graph, uuid, ntid);
        if let (Some(bk), Some(u)) = (
            dto["backend_key"].as_str().map(|s| s.strip_prefix("gui:").unwrap_or(s)),
            uuid,
        ) {
            let native_principal = format!("kode:{bk}:{u}");
            link_pair(&mut graph, Some(&native_principal), Some(u));
            link_pair(&mut graph, Some(&native_principal), rsid);
        }
        if let Some(local_id) = snap["local_id"].as_u64().or_else(|| dto["id"].as_u64()) {
            let gui_principal = format!("kode:runtime:gui:{local_id}");
            link_pair(&mut graph, Some(&gui_principal), rsid);
            link_pair(&mut graph, Some(&gui_principal), uuid);
            link_pair(&mut graph, Some(&gui_principal), ntid);
        }
    }
    graph
}

pub fn expand_session_key(
    seed: &str,
    graph: &HashMap<String, HashSet<String>>,
) -> Vec<String> {
    let mut visited = HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    if !seed.is_empty() {
        visited.insert(seed.to_owned());
        queue.push_back(seed.to_owned());
    }
    while let Some(cur) = queue.pop_front() {
        if visited.len() >= 16 {
            break;
        }
        if let Some(neighbors) = graph.get(&cur) {
            for next in neighbors {
                if visited.insert(next.clone()) {
                    queue.push_back(next.clone());
                }
            }
        }
    }
    let mut out: Vec<String> = visited.into_iter().collect();
    out.sort();
    out
}

pub fn roster_session_maps(
    roster: &Roster,
    graph: &HashMap<String, HashSet<String>>,
) -> (serde_json::Map<String, Value>, BTreeMap<String, String>) {
    let mut main_aliases = serde_json::Map::new();
    for bot in &roster.bots {
        if let Some(main) = &bot.main_session {
            let aliases = expand_session_key(&main.session_id, graph);
            main_aliases.insert(bot.id.clone(), serde_json::json!(aliases));
        }
    }
    let known: HashSet<&str> = roster.bots.iter().map(|b| b.id.as_str()).collect();
    let mut adopted_aliases = BTreeMap::new();
    for (session, bot_id) in &roster.adopted {
        if !known.contains(bot_id.as_str()) {
            continue;
        }
        for alias in expand_session_key(session, graph) {
            adopted_aliases.entry(alias).or_insert_with(|| bot_id.clone());
        }
    }
    (main_aliases, adopted_aliases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn effective_prompt_combines_persona_tone_and_active_connectors() {
        let mut bot: Bot = serde_json::from_value(json!({
            "name": "刷掌PM",
            "backend_key": "claude",
            "persona": "负责需求对齐与任务派发。"
        }))
        .unwrap();
        bot.id = "bot_pm".into();
        let voices = json!({
            "value": { "voices": { "bot_pm": { "tone": "direct", "tone_note": "结论不超过三行" } } }
        });
        let connectors = json!({
            "value": {
                "connectors": [
                    { "id": "c1", "bot_id": "bot_pm", "type": "wecom", "name": "研发群", "enabled": true, "config": { "chat_id": "wr_123" } },
                    { "id": "c2", "bot_id": "bot_pm", "type": "github", "name": "Disabled", "enabled": false, "config": {} }
                ]
            }
        });
        let prompt = effective_prompt_from_docs(&bot, &voices, &connectors);
        assert!(prompt.contains("负责需求对齐与任务派发。"));
        assert!(prompt.contains("kode_sessions_create"));
        assert!(prompt.contains("沟通语气与表达风格（干脆利落）"));
        assert!(prompt.contains("结论不超过三行"));
        assert!(prompt.contains("研发群（wecom）"));
        assert!(prompt.contains("wr_123"));
        assert!(!prompt.contains("Disabled"));
    }

    #[test]
    fn session_aliases_bridge_dsh_and_native_cli_threads() {
        let index = json!({
            "value": {
                "native_sessions": [
                    { "backend_key": "claude", "session_id": "uuid-main", "dsh_session_id": "session-main" },
                    { "backend_key": "codex", "session_id": "uuid-sub", "dsh_session_id": "session-sub" }
                ]
            }
        });
        let snaps = vec![json!({
            "local_id": 42,
            "dto": { "runtime": "gui", "runtime_session_id": "gui:999:1", "session_uuid": "uuid-main" }
        })];
        let graph = build_session_aliases(&index, &snaps);
        let expanded = expand_session_key("session-main", &graph);
        assert!(expanded.contains(&"uuid-main".to_string()));
        assert!(expanded.contains(&"gui:999:1".to_string()));
        assert!(expanded.contains(&"kode:runtime:gui:42".to_string()));
    }
}
