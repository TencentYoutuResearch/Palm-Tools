//! Fact 数据模型 + markdown 文件 (de)serialization。
//!
//! 文件格式:
//! ```text
//! ---
//! <yaml frontmatter>
//! ---
//! <body>
//! ```

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

/// 作用域:facts 按这个隔离 + 索引。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "snake_case")]
pub enum Scope {
    /// 项目级:绑定到某个项目 slug(通常是 cwd 哈希或仓库名)
    Project(String),
    /// 跨项目共享池:不属于任何具体项目,所有 agent 都可访问(通用知识 / 用户偏好)。
    /// 2026-06:旧的 `Global` 已并入此变体,语义重叠故合并。
    Shared,
}

impl Scope {
    pub fn as_str(&self) -> String {
        match self {
            Self::Project(s) => format!("project:{}", s),
            Self::Shared => "shared".to_string(),
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        // `global` 是旧别名,已并入 `shared` — 兼容老输入。
        if s == "shared" || s == "global" {
            Ok(Self::Shared)
        } else if let Some(name) = s.strip_prefix("project:") {
            Ok(Self::Project(name.to_string()))
        } else {
            Err(anyhow!("invalid scope: {}", s))
        }
    }
}

/// fact 的"种类":让 LLM 检索时能按"我在找哪种知识"过滤,
/// 也让 review 时一眼看出条目用途。
///
/// **dead_end** 是这个枚举的存在理由 —— agent 试过但失败的方案,
/// 写下来防止下个 agent(或一周后的我自己)再走一次同样的弯路。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// 默认:踩坑 / 注意事项 / 怪事
    Gotcha,
    /// 不变量:必须保持的状态(违反 = bug)
    Invariant,
    /// 配方:做 X 的标准步骤
    Recipe,
    /// 失败方案:试过但行不通,记下来防 agent 重试
    DeadEnd,
    /// 用户偏好(谨慎用 —— 偏好库不归 memory 管,但 review 时偶尔会保留高价值偏好)
    Preference,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gotcha => "gotcha",
            Self::Invariant => "invariant",
            Self::Recipe => "recipe",
            Self::DeadEnd => "dead_end",
            Self::Preference => "preference",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "gotcha" => Ok(Self::Gotcha),
            "invariant" => Ok(Self::Invariant),
            "recipe" => Ok(Self::Recipe),
            "dead_end" => Ok(Self::DeadEnd),
            "preference" => Ok(Self::Preference),
            other => Err(anyhow!("invalid kind: {}", other)),
        }
    }
}

impl Default for Kind {
    fn default() -> Self {
        Self::Gotcha
    }
}

/// frontmatter 里的元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactMeta {
    pub id: String,     // ULID
    pub author: String, // 谁写的(agent 名 / 用户)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>, // 写入时所在 session
    pub scope: String,  // Scope::as_str() 的字符串形式
    pub created: String, // RFC3339
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// 2026-07+:人类可读标题(用于 Obsidian 文件名 slug 和列表显示)。
    /// 由 propose 时 agent 提供;缺失时 store 会从 tags/body 自动派生。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_days: Option<u32>,
    #[serde(default)]
    pub deprecated: bool,
    /// 2026-06+:种类(默认 `gotcha`,老 fact 自动落到默认)
    #[serde(default)]
    pub kind: Kind,
    /// 子系统(可空):pty / gui / memory / session / config / ... 自由文本,
    /// 用于按子系统过滤检索。约定但不强制枚举值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subsystem: Option<String>,
    /// 路径 glob 列表(可空):此 fact 适用于哪些代码路径。
    /// search 时若调用方提供 cwd_file,且匹配中此 glob,得到一定打分加权。
    /// 例:["src/pty/**", "src/session/state.rs"]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub applies_to: Vec<String>,
    /// **遗留字段**(2026-06 早期):泛型链字段。
    /// reconcile 会把非空 `links` 自动迁移到 `related` 并清空。
    /// 新代码**不要**写这个字段;读取仍兼容。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<String>,
    /// **2026-06 Phase 10.10**:相关 fact(同主题、互补、延伸)。
    /// frontmatter 写法:`related: [01HXYZ, 01HABC]`(Obsidian 也认 `[[01HXYZ]]` 风格)。
    /// store 同步建反向索引到 SQLite `links` 表(kind=related)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<String>,
    /// **2026-06 Phase 10.10**:与本条**冲突**的 fact ULID 列表。
    /// 用于"试过但和现有结论矛盾"的场景;搜索时可作"双方都可见"的提醒。
    /// store 同步建反向索引(kind=contradicts)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contradicts: Vec<String>,
    /// **2026-06 Phase 10.11**(仅当 kind == DeadEnd 时有意义):试过什么。
    /// 例:"用 Mutex<Child> 同时 wait + kill"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tried: Option<String>,
    /// **2026-06 Phase 10.11**:失败原因。例:"互斥锁双持死锁"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_because: Option<String>,
    /// **2026-06 Phase 10.11**:推荐用什么替代。例:"clone_killer() 拿独立句柄"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_instead: Option<String>,
}

fn default_confidence() -> f32 {
    0.8
}

/// 一条完整的 fact = frontmatter + body。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub meta: FactMeta,
    pub body: String,
}

impl Fact {
    /// 序列化成 markdown 文件内容。
    pub fn to_markdown(&self) -> Result<String> {
        let yaml = serde_yaml::to_string(&self.meta).context("serialize frontmatter")?;
        Ok(format!("---\n{}---\n{}\n", yaml, self.body.trim_end()))
    }

    /// 从 markdown 文件内容解析。
    pub fn from_markdown(text: &str) -> Result<Self> {
        let text = text.trim_start();
        let rest = text
            .strip_prefix("---\n")
            .or_else(|| text.strip_prefix("---\r\n"))
            .ok_or_else(|| anyhow!("missing frontmatter opener"))?;

        // 找 closing "---"
        let (yaml_str, body_str) = split_frontmatter(rest)?;
        let meta: FactMeta = serde_yaml::from_str(yaml_str).context("parse frontmatter yaml")?;
        Ok(Self {
            meta,
            body: body_str.trim().to_string(),
        })
    }
}

fn split_frontmatter(rest: &str) -> Result<(&str, &str)> {
    // 找一行只有 "---"(或 "---\r")的位置
    let mut idx = 0;
    for line in rest.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" {
            let yaml = &rest[..idx];
            let body = &rest[idx + line.len()..];
            return Ok((yaml, body));
        }
        idx += line.len();
    }
    Err(anyhow!("missing frontmatter closer"))
}

/// 从 title 生成文件名 slug:kebab-case,≤60 字符。
/// 无 title 时返回空字符串 → 文件名退化为纯 ULID。
pub fn slug_from_title(title: Option<&str>) -> String {
    let raw = match title {
        Some(t) if !t.trim().is_empty() => t,
        _ => return String::new(),
    };
    let mut slug = String::with_capacity(raw.len().min(60));
    let mut prev_dash = false;
    for ch in raw.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && (ch == '-' || ch == ' ' || ch == '_') {
            slug.push('-');
            prev_dash = true;
        }
        // 其他字符(中文字等)丢弃
        if slug.len() >= 60 {
            break;
        }
    }
    // 去掉尾部的 -
    while slug.ends_with('-') {
        slug.pop();
    }
    // 去掉前导的 -(罕见,但防)
    while slug.starts_with('-') {
        slug.remove(0);
    }
    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_markdown() {
        let f = Fact {
            meta: FactMeta {
                id: "01HXYZ".into(),
                author: "codebuddy".into(),
                session: Some("abc".into()),
                scope: "project:kode".into(),
                created: "2026-06-02T10:00:00Z".into(),
                confidence: 0.9,
                tags: vec!["pty".into(), "deadlock".into()],
                title: Some("Pty Kill Deadlock Fix".into()),
                supersedes: None,
                ttl_days: None,
                deprecated: false,
                kind: Kind::Gotcha,
                subsystem: Some("pty".into()),
                applies_to: vec!["src/pty/**".into()],
                links: vec!["01HABC".into()],
                related: vec![],
                contradicts: vec![],
                tried: None,
                failed_because: None,
                use_instead: None,
            },
            body: "PtyHost::kill 必须用 clone_killer()。".into(),
        };
        let md = f.to_markdown().unwrap();
        let parsed = Fact::from_markdown(&md).unwrap();
        assert_eq!(parsed.meta.id, "01HXYZ");
        assert_eq!(parsed.meta.tags, vec!["pty", "deadlock"]);
        assert_eq!(parsed.meta.title.as_deref(), Some("Pty Kill Deadlock Fix"));
        assert_eq!(parsed.meta.subsystem.as_deref(), Some("pty"));
        assert_eq!(parsed.meta.applies_to, vec!["src/pty/**"]);
        assert_eq!(parsed.meta.links, vec!["01HABC"]);
        assert_eq!(parsed.meta.kind, Kind::Gotcha);
        assert!(parsed.body.contains("clone_killer"));
    }

    #[test]
    fn legacy_fact_parses_with_default_kind() {
        // 老 fact(没有 kind / subsystem / applies_to / links)应能解析,字段取默认
        let md = r#"---
id: 01HOLD
author: tester
scope: shared
created: 2026-01-01T00:00:00Z
confidence: 0.8
tags: []
deprecated: false
---
老 fact 的 body
"#;
        let parsed = Fact::from_markdown(md).unwrap();
        assert_eq!(parsed.meta.kind, Kind::Gotcha);
        assert!(parsed.meta.subsystem.is_none());
        assert!(parsed.meta.applies_to.is_empty());
        assert!(parsed.meta.links.is_empty());
    }

    #[test]
    fn kind_parse_roundtrip() {
        for s in ["gotcha", "invariant", "recipe", "dead_end", "preference"] {
            assert_eq!(Kind::parse(s).unwrap().as_str(), s);
        }
        assert!(Kind::parse("nope").is_err());
    }

    #[test]
    fn scope_parse_roundtrip() {
        for s in ["shared", "project:kode", "project:foo-bar"] {
            assert_eq!(Scope::parse(s).unwrap().as_str(), s);
        }
        // `global` 是旧别名,parse 成 Shared(归一化,不再 roundtrip 回 "global")
        assert_eq!(Scope::parse("global").unwrap(), Scope::Shared);
        assert!(Scope::parse("nope").is_err());
    }

    #[test]
    fn missing_frontmatter_errors() {
        assert!(Fact::from_markdown("no frontmatter here").is_err());
        assert!(Fact::from_markdown("---\nstill no closer").is_err());
    }

    #[test]
    fn related_and_contradicts_roundtrip() {
        let f = Fact {
            meta: FactMeta {
                id: "01N".into(),
                author: "u".into(),
                session: None,
                scope: "shared".into(),
                created: "2026-06-07T00:00:00Z".into(),
                confidence: 0.8,
                tags: vec![],
                title: None,
                supersedes: None,
                ttl_days: None,
                deprecated: false,
                kind: Kind::Gotcha,
                subsystem: None,
                applies_to: vec![],
                links: vec![],
                related: vec!["01A".into(), "01B".into()],
                contradicts: vec!["01C".into()],
                tried: None,
                failed_because: None,
                use_instead: None,
            },
            body: "see related ids".into(),
        };
        let md = f.to_markdown().unwrap();
        let parsed = Fact::from_markdown(&md).unwrap();
        assert_eq!(parsed.meta.related, vec!["01A", "01B"]);
        assert_eq!(parsed.meta.contradicts, vec!["01C"]);
        // 空字段不应出现在 yaml 里(skip_serializing_if = Vec::is_empty)
        assert!(!md.contains("links:"), "empty links should be skipped");
        assert!(!md.contains("tried:"));
    }

    #[test]
    fn dead_end_with_three_fields_roundtrip() {
        let f = Fact {
            meta: FactMeta {
                id: "01D".into(),
                author: "codebuddy".into(),
                session: None,
                scope: "project:kode".into(),
                created: "2026-06-07T00:00:00Z".into(),
                confidence: 0.9,
                tags: vec!["pty".into()],
                title: None,
                supersedes: None,
                ttl_days: None,
                deprecated: false,
                kind: Kind::DeadEnd,
                subsystem: Some("pty".into()),
                applies_to: vec!["src/pty/**".into()],
                links: vec![],
                related: vec![],
                contradicts: vec![],
                tried: Some("Mutex<Child> 同时 wait + kill".into()),
                failed_because: Some("互斥锁双持死锁".into()),
                use_instead: Some("clone_killer() 拿独立句柄".into()),
            },
            body: "记录 PtyHost::kill 走过的弯路。".into(),
        };
        let md = f.to_markdown().unwrap();
        let parsed = Fact::from_markdown(&md).unwrap();
        assert_eq!(parsed.meta.kind, Kind::DeadEnd);
        assert_eq!(
            parsed.meta.tried.as_deref(),
            Some("Mutex<Child> 同时 wait + kill")
        );
        assert_eq!(
            parsed.meta.failed_because.as_deref(),
            Some("互斥锁双持死锁")
        );
        assert_eq!(
            parsed.meta.use_instead.as_deref(),
            Some("clone_killer() 拿独立句柄")
        );
    }

    #[test]
    fn legacy_fact_without_new_link_fields_defaults_empty() {
        // 旧 fact:无 related / contradicts / tried 等
        let md = r#"---
id: 01HOLD2
author: tester
scope: shared
created: 2026-01-01T00:00:00Z
confidence: 0.8
tags: []
deprecated: false
---
旧 fact 的 body
"#;
        let parsed = Fact::from_markdown(md).unwrap();
        assert!(parsed.meta.related.is_empty());
        assert!(parsed.meta.contradicts.is_empty());
        assert!(parsed.meta.tried.is_none());
        assert!(parsed.meta.failed_because.is_none());
        assert!(parsed.meta.use_instead.is_none());
    }

    #[test]
    fn legacy_links_field_still_parses() {
        // 老 fact 用 links 字段(还没迁到 related)
        let md = r#"---
id: 01HOLD3
author: tester
scope: shared
created: 2026-05-01T00:00:00Z
confidence: 0.8
tags: []
deprecated: false
links:
  - 01ABC
  - 01DEF
---
带 links 字段的老 fact
"#;
        let parsed = Fact::from_markdown(md).unwrap();
        assert_eq!(parsed.meta.links, vec!["01ABC", "01DEF"]);
        // related 应为空(reconcile 会迁,fact.rs 不擅自迁)
        assert!(parsed.meta.related.is_empty());
    }

    #[test]
    fn slug_from_title_basic() {
        assert_eq!(slug_from_title(None), "");
        assert_eq!(slug_from_title(Some("")), "");
        assert_eq!(slug_from_title(Some("   ")), "");
        assert_eq!(
            slug_from_title(Some("Pty Kill Deadlock Fix")),
            "pty-kill-deadlock-fix"
        );
        assert_eq!(
            slug_from_title(Some("GUI: Tab Avatar Convention")),
            "gui-tab-avatar-convention"
        );
        assert_eq!(
            slug_from_title(Some("Rust 测试组织规则:几十行白盒单测")),
            "rust"
        );
    }

    #[test]
    fn slug_from_title_trims_to_60_chars() {
        let long = "A".repeat(100);
        let slug = slug_from_title(Some(&long));
        assert_eq!(slug.len(), 60);
        assert!(slug.chars().all(|c| c == 'a'));
    }

    #[test]
    fn slug_from_title_collapses_dashes() {
        assert_eq!(slug_from_title(Some("a---b  c_d")), "a-b-c-d");
    }

    #[test]
    fn title_frontmatter_roundtrip() {
        let f = Fact {
            meta: FactMeta {
                id: "01TITLE".into(),
                author: "codebuddy".into(),
                session: None,
                scope: "project:kode".into(),
                created: "2026-07-02T00:00:00Z".into(),
                confidence: 0.8,
                tags: vec![],
                title: Some("Pty Kill Deadlock Fix".into()),
                supersedes: None,
                ttl_days: None,
                deprecated: false,
                kind: Kind::Gotcha,
                subsystem: None,
                applies_to: vec![],
                links: vec![],
                related: vec![],
                contradicts: vec![],
                tried: None,
                failed_because: None,
                use_instead: None,
            },
            body: "test".into(),
        };
        let md = f.to_markdown().unwrap();
        assert!(md.contains("title: Pty Kill Deadlock Fix"));
        let parsed = Fact::from_markdown(&md).unwrap();
        assert_eq!(parsed.meta.title.as_deref(), Some("Pty Kill Deadlock Fix"));
    }
}
