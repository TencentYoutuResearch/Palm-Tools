//! Watch specs and event matching. Pure: the dispatcher feeds events in.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Built-in topics; extensions publish `<extension-id>/<name>`.
/// `schedule` is a time trigger: `match.cron` is a cron expression in local time.
pub const BUILTIN_TOPICS: &[&str] = &["session.turn_completed", "session.awaiting", "session.exited", "fs.changed", "git.commit", "git.branch", "schedule"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    pub name: String,
    pub on: Trigger,
    /// What the bot does each time (its instructions for the run).
    #[serde(rename = "do")]
    pub instructions: String,
    #[serde(default)]
    pub policy: Policy,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub topic: String,
    /// Payload conditions: equality, `*`/`**` globs on strings, membership on arrays.
    #[serde(default, rename = "match")]
    pub conditions: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, default)]
pub struct Policy {
    /// Events within this window become one run.
    pub coalesce_secs: u64,
    pub max_runs_per_hour: u64,
    /// `plan` (default), `default` or `acceptEdits`, never above the bot's ceiling.
    pub permission: String,
    /// Where the run works; default the bot's own workspace.
    pub workspace: Option<String>,
    /// Tell the run what the previous run concluded.
    pub carry_last_summary: bool,
    /// `always`, `attention` (default: only when the run asks for you or fails) or `never`.
    pub notify: String,
    /// Also post the conclusion into the bot's main conversation.
    pub report_to_main: bool,
    /// Also send the report to this WeCom chat (through the bot's WeCom tool,
    /// so a bot that drafts outbound messages drafts this one too).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_to_wecom: Option<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Self { coalesce_secs: 30, max_runs_per_hour: 6, permission: "plan".into(), workspace: None, carry_last_summary: true, notify: "attention".into(), report_to_main: true, post_to_wecom: None }
    }
}

impl Spec {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            bail!("关注需要 1–80 个字的名字")
        }
        if self.instructions.trim().is_empty() || self.instructions.len() > 8000 {
            bail!("写清楚伙伴每次要做什么（不超过 8000 字节）")
        }
        let topic = self.on.topic.as_str();
        let published = topic.split_once('/').is_some_and(|(ext, name)| crate::messaging::model::valid_id(ext) && !name.is_empty() && name.len() <= 64);
        if !BUILTIN_TOPICS.contains(&topic) && !published {
            bail!("不认识的事件 {topic}")
        }
        if topic.starts_with("fs.") || topic.starts_with("git.") {
            match self.on.conditions.get("workspace").and_then(Value::as_str) {
                Some(path) if std::path::Path::new(path).is_absolute() => {}
                _ => bail!("文件和 Git 事件需要指定要关注的工作区（绝对路径）"),
            }
        }
        if topic == "schedule" {
            let cron = self.on.conditions.get("cron").and_then(Value::as_str).ok_or_else(|| anyhow::anyhow!("定时关注需要填写时间（cron）"))?;
            super::schedule::Cron::parse(cron)?;
        }
        if self.policy.post_to_wecom.as_deref().is_some_and(|chat| chat.trim().is_empty() || chat.len() > 128 || chat.chars().any(char::is_control)) {
            bail!("企业微信会话 chat_id 无效")
        }
        if !matches!(self.policy.permission.as_str(), "plan" | "default" | "acceptEdits") {
            bail!("事件触发的运行最高到「可以改文件」")
        }
        if !matches!(self.policy.notify.as_str(), "always" | "attention" | "never") {
            bail!("unknown notify policy")
        }
        if self.policy.coalesce_secs > 3600 || self.policy.max_runs_per_hour == 0 || self.policy.max_runs_per_hour > 60 {
            bail!("合并窗口最多 1 小时，每小时 1–60 次")
        }
        if self.policy.workspace.as_deref().is_some_and(|w| !std::path::Path::new(w).is_absolute()) {
            bail!("运行工作区必须是绝对路径")
        }
        Ok(())
    }

    /// The cron of a time trigger.
    pub fn cron(&self) -> Option<&str> {
        (self.on.topic == "schedule").then(|| self.on.conditions.get("cron").and_then(Value::as_str)).flatten()
    }

    pub fn matches(&self, topic: &str, payload: &Value) -> bool {
        // Time triggers are fired by the dispatcher's clock, never by events.
        self.on.topic != "schedule" && self.on.topic == topic && self.on.conditions.iter().all(|(key, expected)| condition(lookup(payload, key), expected))
    }
}

fn lookup<'a>(payload: &'a Value, key: &str) -> &'a Value {
    key.split('.').fold(payload, |value, part| &value[part])
}

fn condition(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (_, Value::Array(any)) => any.iter().any(|one| condition(actual, one)),
        (Value::Array(items), _) => items.iter().any(|item| condition(item, expected)),
        (Value::String(text), Value::String(pattern)) if pattern.contains('*') || pattern.contains('?') => glob(pattern, text),
        // A workspace matches itself and anything inside it.
        (Value::String(text), Value::String(prefix)) if prefix.starts_with('/') && text.starts_with('/') => {
            text == prefix || text.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
        }
        _ => actual == expected,
    }
}

/// `**` crosses `/`, `*` does not, `?` is one character.
pub fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => {
                let rest = if p.get(2) == Some(&'/') { &p[3..] } else { &p[2..] };
                (0..=t.len()).any(|i| go(rest, &t[i..])) || go(&p[2..], t)
            }
            Some('*') => (0..=t.len()).take_while(|i| *i == 0 || t[i - 1] != '/').any(|i| go(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && t[0] != '/' && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    go(&p, &t)
}

/// A short line describing an event for the run's instructions.
pub fn describe(topic: &str, payload: &Value) -> String {
    let field = |key: &str| payload[key].as_str().unwrap_or_default().to_owned();
    let text = match topic {
        "session.turn_completed" => format!("会话「{}」完成了一轮（{}）：{}", field("title"), field("cwd"), payload["final_message"]["text"].as_str().unwrap_or("").chars().take(600).collect::<String>()),
        "session.awaiting" => format!("会话「{}」在等人处理：{}", field("title"), field("summary")),
        "session.exited" => match payload["final_message"]["text"].as_str().filter(|t| !t.trim().is_empty()) {
            Some(last) => format!("会话「{}」结束了（{}），它最后说：{}", field("title"), field("cwd"), last.chars().take(600).collect::<String>()),
            None => format!("会话「{}」结束了（{}），没有留下文字结论", field("title"), field("cwd")),
        },
        "fs.changed" => format!("{} 有文件变化：{}", field("workspace"), payload["paths"].as_array().map(|p| p.iter().filter_map(Value::as_str).take(20).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
        "git.commit" => format!("{} 的 {} 分支有新提交 {}", field("workspace"), field("branch"), field("head")),
        "git.branch" => format!("{} 切换到分支 {}", field("workspace"), field("branch")),
        "wecom/message" => {
            let chat = payload["chat_name"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| payload["chat_id"].as_str().unwrap_or("未知会话"));
            let sender = payload["sender_name"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| payload["sender"].as_str().unwrap_or("成员"));
            let content: String = payload["content"].as_str().unwrap_or_default().chars().take(600).collect();
            format!("企业微信「{chat}」（chat_id={}）收到 {sender} 的消息：{content}", field("chat_id"))
        }
        "manual" => "你在伙伴页里手动运行了这个关注".into(),
        "schedule" => {
            let when = super::schedule::describe(payload["cron"].as_str().unwrap_or_default());
            if payload["missed"] == true {
                format!("定时任务（{when}）到点时 Kode 没有在运行，现在补跑一次")
            } else {
                format!("定时任务到点：{when}")
            }
        }
        _ => format!("{topic}：{}", payload.to_string().chars().take(800).collect::<String>()),
    };
    text.chars().take(1200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(on: Value) -> Spec {
        serde_json::from_value(json!({"name":"t","on":on,"do":"x"})).unwrap()
    }

    #[test]
    fn globs_follow_path_rules() {
        assert!(glob("src/**/*.rs", "src/a/b/c.rs"));
        assert!(glob("src/**/*.rs", "src/c.rs"));
        assert!(!glob("src/*.rs", "src/a/c.rs"));
        assert!(glob("*.md", "README.md"));
        assert!(!glob("?.md", "ab.md"));
    }

    #[test]
    fn conditions_cover_equality_globs_lists_and_workspaces() {
        let w = spec(json!({"topic":"fs.changed","match":{"workspace":"/w/repo","paths":"src/**"}}));
        assert!(w.matches("fs.changed", &json!({"workspace":"/w/repo","paths":["README.md","src/lib.rs"]})));
        assert!(!w.matches("fs.changed", &json!({"workspace":"/w/repo","paths":["docs/a.md"]})));
        assert!(!w.matches("fs.changed", &json!({"workspace":"/w/other","paths":["src/lib.rs"]})));
        assert!(!w.matches("git.commit", &json!({"workspace":"/w/repo"})));
        let s = spec(json!({"topic":"session.turn_completed","match":{"cwd":"/w/repo","labels":["team:call","crew:lead"]}}));
        assert!(s.matches("session.turn_completed", &json!({"cwd":"/w/repo/sub","labels":["crew:lead"]})));
        assert!(!s.matches("session.turn_completed", &json!({"cwd":"/w/repository","labels":["crew:lead"]})), "a workspace is not a string prefix");
        let any = spec(json!({"topic":"kode.team/mention"}));
        assert!(any.matches("kode.team/mention", &json!({})));
    }

    #[test]
    fn exits_tell_what_the_session_last_said() {
        let said = describe("session.exited", &json!({"title":"Commit Code","cwd":"/w","final_message":{"text":"Pushed 3 commits."}}));
        assert!(said.contains("Pushed 3 commits."), "{said}");
        assert!(describe("session.exited", &json!({"title":"t","cwd":"/w"})).contains("没有留下文字结论"));
    }

    #[test]
    fn specs_reject_unsafe_or_incomplete_watches() {
        assert!(spec(json!({"topic":"fs.changed"})).validate().is_err(), "fs needs a workspace");
        assert!(spec(json!({"topic":"cron.tick"})).validate().is_err());
        let mut full = spec(json!({"topic":"session.awaiting"}));
        full.policy.permission = "bypassPermissions".into();
        assert!(full.validate().is_err(), "a watch never runs with full access");
        assert!(spec(json!({"topic":"kode.team/mention"})).validate().is_ok());
        assert!(spec(json!({"topic":"wecom/message"})).validate().is_ok());
        assert!(spec(json!({"topic":"schedule"})).validate().is_err(), "a time trigger needs a cron");
        assert!(spec(json!({"topic":"schedule","match":{"cron":"0 25 * * *"}})).validate().is_err());
        let daily = spec(json!({"topic":"schedule","match":{"cron":"0 9 * * 1-5"}}));
        assert!(daily.validate().is_ok());
        assert_eq!(daily.cron(), Some("0 9 * * 1-5"));
        assert!(!daily.matches("schedule", &json!({"cron":"0 9 * * 1-5"})), "only the clock fires a schedule");
        assert!(describe("schedule", &json!({"cron":"0 9 * * 1-5","missed":true})).contains("补跑"));
    }

    #[test]
    fn wecom_message_events_match_chat_id_and_format_human_summary() {
        let w = spec(json!({"topic":"wecom/message","match":{"chat_id":"group_1"}}));
        let payload = json!({"chat_id":"group_1","chat_name":"研发群","sender":"alice","sender_name":"Alice","content":"请帮忙查一下构建失败原因"});
        assert!(w.matches("wecom/message", &payload));
        assert!(!w.matches("wecom/message", &json!({"chat_id":"group_2","content":"hi"})));
        let summary = describe("wecom/message", &payload);
        assert!(summary.contains("研发群") && summary.contains("group_1") && summary.contains("Alice") && summary.contains("构建失败原因"), "{summary}");
    }
}
