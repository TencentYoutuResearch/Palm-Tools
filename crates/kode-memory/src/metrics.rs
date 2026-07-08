//! M5 metrics 事件流(Phase 10.5)。
//!
//! `.kode/metrics.jsonl` append-only,一行一个 JSON 事件。**不 fsync** —
//! 事件偶尔丢一两条可接受(crash 时最多丢最近几条),换更高的吞吐。
//!
//! ## 事件 schema
//!
//! ```json
//! {"ts": 1717689600, "kind": "propose", "author": "codebuddy", "scope": "project:kode", "fact_id": "01J..."}
//! {"ts": 1717689700, "kind": "approve", "author": "user", "fact_id": "01J..."}
//! {"ts": 1717689800, "kind": "search", "author": "codebuddy", "query": "pty kill", "top_k": 5}
//! {"ts": 1717689900, "kind": "recall_clicked", "author": "user", "fact_id": "01J...", "query": "pty"}
//! ```
//!
//! ## 不变量
//!
//! 1. **append-only**:`open()` 用 `OpenOptions::append(true)`,任何调用方都不许 truncate
//! 2. **streaming aggregate**:`aggregate_7d()` 一行一行读,不 load 全文件
//! 3. **坏行容忍**:解析失败的行直接跳过,不 panic、不 abort
//! 4. **不阻塞调用方**:`append()` 失败用 `tracing::warn!` 记 log,**不传错**
//!    (memory 主路径不能因为 metrics 写失败就 fail)

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 事件类型。snake_case 序列化到 jsonl,与 ROADMAP §10.5 文档对齐。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    /// agent 提议一条新 fact(无论是否成功 — 失败也记)
    Propose,
    /// 用户审核 → approve
    Approve,
    /// 用户审核 → edit-then-approve
    EditThenApprove,
    /// 用户审核 → reject
    Reject,
    /// 用户审核 → blacklist
    Blacklist,
    /// agent 调 search(top_k 不为空)
    Search,
    /// 用户在 GUI Browse 点击了某条结果(召回反馈)
    RecallClicked,
    /// 用户/系统 deprecate 一条 fact
    Deprecate,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Propose => "propose",
            Self::Approve => "approve",
            Self::EditThenApprove => "edit_then_approve",
            Self::Reject => "reject",
            Self::Blacklist => "blacklist",
            Self::Search => "search",
            Self::RecallClicked => "recall_clicked",
            Self::Deprecate => "deprecate",
        }
    }

    /// 是否算"用户对 propose 的处置"(用于接受率分母)
    pub fn is_review_terminal(self) -> bool {
        matches!(
            self,
            Self::Approve | Self::EditThenApprove | Self::Reject | Self::Blacklist
        )
    }

    /// 是否算"接受"(用于接受率分子)
    pub fn is_accept(self) -> bool {
        matches!(self, Self::Approve | Self::EditThenApprove)
    }
}

/// 一条事件。所有字段都是可选,各 kind 用到不同子集 — 留单一结构体减少 enum 分支。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsEvent {
    pub ts: i64,
    pub kind: EventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fact_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl MetricsEvent {
    /// 工厂:用 EventKind 起手,链式补字段。比直接 struct literal 写得短。
    pub fn new(kind: EventKind) -> Self {
        Self {
            ts: now_secs(),
            kind,
            author: None,
            fact_id: None,
            scope: None,
            query: None,
            top_k: None,
            hit_id: None,
            reason: None,
        }
    }

    pub fn author(mut self, v: impl Into<String>) -> Self {
        self.author = Some(v.into());
        self
    }
    pub fn fact_id(mut self, v: impl Into<String>) -> Self {
        self.fact_id = Some(v.into());
        self
    }
    pub fn scope(mut self, v: impl Into<String>) -> Self {
        self.scope = Some(v.into());
        self
    }
    pub fn query(mut self, v: impl Into<String>) -> Self {
        self.query = Some(v.into());
        self
    }
    pub fn top_k(mut self, v: usize) -> Self {
        self.top_k = Some(v);
        self
    }
    pub fn hit_id(mut self, v: impl Into<String>) -> Self {
        self.hit_id = Some(v.into());
        self
    }
    pub fn reason(mut self, v: impl Into<String>) -> Self {
        self.reason = Some(v.into());
        self
    }
}

/// 7 天聚合输出。给 GUI hover 卡片 + CLI dashboard 用。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Aggregate7d {
    /// 各 kind 计数(7 天窗口内)
    pub by_kind: std::collections::HashMap<String, u64>,
    /// 总事件数(7 天窗口内,所有 kind 合)
    pub totals: u64,
    /// 接受率 = (approve + edit_then_approve) / (approve + edit_then_approve + reject + blacklist)
    /// 分母为 0 时返回 None
    pub accept_rate: Option<f32>,
    /// 按 author 分组的接受率
    pub by_author_accept_rate: std::collections::HashMap<String, AuthorAcceptRate>,
    /// 今日(0 点至现在)的 propose 总数 — GUI hover 卡片直接显示
    pub today_proposes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthorAcceptRate {
    pub accepts: u64,
    pub total_reviews: u64,
    /// rate = accepts / total_reviews,分母 0 时为 None
    pub rate: Option<f32>,
}

/// 写入端:并发安全的 append-only 句柄。
///
/// 内部用 `Mutex<File>` 串行 write — `metrics.jsonl` 写入很轻(一行 ~200B),
/// 不需要 lock-free。读端走 `aggregate_7d()` 重新打开文件流式读,与写互不影响。
pub struct MetricsLog {
    path: PathBuf,
    file: Mutex<File>,
}

impl MetricsLog {
    /// 打开 `<root>/.kode/metrics.jsonl`(append 模式,不存在则创建)。
    /// 父目录由 `MemoryStore::open` 提前建好,这里只 OpenOptions。
    pub fn open(root: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = root.as_ref().join(".kode").join("metrics.jsonl");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    /// Append 一条事件。失败只 log,不返错 — memory 主路径不能因为 metrics 挂掉。
    pub fn append(&self, event: &MetricsEvent) {
        let line = match serde_json::to_string(event) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("metrics serialize failed: {}", e);
                return;
            }
        };
        let Ok(mut f) = self.file.lock() else {
            tracing::warn!("metrics mutex poisoned");
            return;
        };
        if let Err(e) = writeln!(f, "{}", line) {
            tracing::warn!("metrics write failed: {}", e);
        }
        // 不 fsync — 设计取舍
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取最近 7 天事件并聚合。streaming 读取,大文件不会 OOM。
    /// 坏行(JSON parse error)直接跳过,不影响其它行。
    pub fn aggregate_7d(&self) -> std::io::Result<Aggregate7d> {
        let now = now_secs();
        let cutoff_7d = now - 7 * 24 * 3600;
        // "今日"= 当前 utc 0 点 之后(简化 — GUI 需求是粗略数字,不必处理时区)
        let cutoff_today = now - (now % 86400);

        let mut agg = Aggregate7d::default();

        // 文件可能不存在(全新 root 第一次打开 aggregate)
        let f = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(agg),
            Err(e) => return Err(e),
        };
        let reader = BufReader::new(f);

        // 中间累积(by author 的 accepts/total_reviews)
        let mut by_author: std::collections::HashMap<String, (u64, u64)> =
            std::collections::HashMap::new();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }
            let event: MetricsEvent = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if event.ts < cutoff_7d {
                continue;
            }
            agg.totals += 1;
            *agg.by_kind
                .entry(event.kind.as_str().to_string())
                .or_insert(0) += 1;

            if event.kind == EventKind::Propose && event.ts >= cutoff_today {
                agg.today_proposes += 1;
            }

            if event.kind.is_review_terminal() {
                if let Some(a) = &event.author {
                    let entry = by_author.entry(a.clone()).or_insert((0, 0));
                    entry.1 += 1; // total
                    if event.kind.is_accept() {
                        entry.0 += 1; // accepts
                    }
                }
            }
        }

        // 总接受率
        let total_accepts = by_author.values().map(|(a, _)| *a).sum::<u64>();
        let total_reviews = by_author.values().map(|(_, t)| *t).sum::<u64>();
        agg.accept_rate = if total_reviews > 0 {
            Some(total_accepts as f32 / total_reviews as f32)
        } else {
            None
        };

        for (author, (accepts, total)) in by_author {
            let rate = if total > 0 {
                Some(accepts as f32 / total as f32)
            } else {
                None
            };
            agg.by_author_accept_rate.insert(
                author,
                AuthorAcceptRate {
                    accepts,
                    total_reviews: total,
                    rate,
                },
            );
        }

        Ok(agg)
    }

    /// 按 fact_id 取该 fact 在最近 30 天的 recall_clicked 次数。
    /// 给 store.rs 的后台聚合 task 用,UPSERT 进 facts.recall_clicked_count_30d。
    pub fn count_recall_clicked_30d(
        &self,
    ) -> std::io::Result<std::collections::HashMap<String, u32>> {
        let now = now_secs();
        let cutoff = now - 30 * 24 * 3600;
        let mut out: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

        let f = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e),
        };
        let reader = BufReader::new(f);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }
            let event: MetricsEvent = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if event.ts < cutoff {
                continue;
            }
            if event.kind == EventKind::RecallClicked {
                if let Some(id) = event.fact_id {
                    *out.entry(id).or_insert(0) += 1;
                }
            }
        }
        Ok(out)
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_log(tmp: &TempDir) -> MetricsLog {
        // .kode 目录得先有(模拟 MemoryStore::open 已建)
        std::fs::create_dir_all(tmp.path().join(".kode")).unwrap();
        MetricsLog::open(tmp.path()).unwrap()
    }

    #[test]
    fn append_and_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let log = make_log(&tmp);
        let ev = MetricsEvent::new(EventKind::Propose)
            .author("codebuddy")
            .scope("project:kode")
            .fact_id("01J");
        log.append(&ev);
        log.append(
            &MetricsEvent::new(EventKind::Approve)
                .author("user")
                .fact_id("01J"),
        );
        // 文件存在且非空
        let content = std::fs::read_to_string(log.path()).unwrap();
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 2);
        // 每行可解析回 MetricsEvent
        let ev0: MetricsEvent = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(ev0.kind, EventKind::Propose);
        assert_eq!(ev0.author.as_deref(), Some("codebuddy"));
    }

    #[test]
    fn aggregate_7d_window_cutoff() {
        let tmp = TempDir::new().unwrap();
        let log = make_log(&tmp);

        let now = now_secs();
        // 8 天前的事件 — 应被过滤
        let mut old = MetricsEvent::new(EventKind::Propose).author("a");
        old.ts = now - 8 * 86400;
        log.append(&old);
        // 1 小时前的事件 — 应被计入
        let mut recent = MetricsEvent::new(EventKind::Propose).author("a");
        recent.ts = now - 3600;
        log.append(&recent);

        let agg = log.aggregate_7d().unwrap();
        assert_eq!(agg.totals, 1);
        assert_eq!(agg.by_kind.get("propose").copied(), Some(1));
    }

    #[test]
    fn malformed_lines_tolerated() {
        let tmp = TempDir::new().unwrap();
        let log = make_log(&tmp);

        // 写一条好的、一条坏的、一条好的
        log.append(&MetricsEvent::new(EventKind::Search).query("pty"));
        // 直接往文件里塞一行垃圾
        {
            use std::io::Write as _;
            let mut f = OpenOptions::new().append(true).open(log.path()).unwrap();
            writeln!(f, "this is not json").unwrap();
            writeln!(f, "{{not really valid").unwrap();
        }
        log.append(&MetricsEvent::new(EventKind::Search).query("gui"));

        let agg = log.aggregate_7d().unwrap();
        // 坏行直接跳过 — 仍算 2 条 search
        assert_eq!(agg.by_kind.get("search").copied(), Some(2));
    }

    #[test]
    fn by_author_accept_rate() {
        let tmp = TempDir::new().unwrap();
        let log = make_log(&tmp);

        // codebuddy: 2 approve / 1 reject → 67%
        log.append(&MetricsEvent::new(EventKind::Approve).author("codebuddy"));
        log.append(&MetricsEvent::new(EventKind::Approve).author("codebuddy"));
        log.append(&MetricsEvent::new(EventKind::Reject).author("codebuddy"));
        // claude: 1 approve / 1 blacklist → 50%
        log.append(&MetricsEvent::new(EventKind::Approve).author("claude"));
        log.append(&MetricsEvent::new(EventKind::Blacklist).author("claude"));
        // 非 review 事件不算
        log.append(&MetricsEvent::new(EventKind::Search).author("codebuddy"));

        let agg = log.aggregate_7d().unwrap();
        let cb = agg.by_author_accept_rate.get("codebuddy").unwrap();
        assert_eq!(cb.accepts, 2);
        assert_eq!(cb.total_reviews, 3);
        assert!((cb.rate.unwrap() - 0.6667).abs() < 1e-3);

        let cl = agg.by_author_accept_rate.get("claude").unwrap();
        assert_eq!(cl.accepts, 1);
        assert_eq!(cl.total_reviews, 2);
        assert!((cl.rate.unwrap() - 0.5).abs() < 1e-3);

        // 总接受率 = (2+1) / (3+2) = 60%
        assert!((agg.accept_rate.unwrap() - 0.6).abs() < 1e-3);
    }

    #[test]
    fn aggregate_on_missing_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kode")).unwrap();
        // 不调 append,直接 open + aggregate(file 不存在等同空)
        let log = MetricsLog::open(tmp.path()).unwrap();
        // 这里 open 已经 create 了空文件,所以再删掉模拟不存在
        std::fs::remove_file(log.path()).unwrap();
        let agg = log.aggregate_7d().unwrap();
        assert_eq!(agg.totals, 0);
        assert!(agg.accept_rate.is_none());
    }

    #[test]
    fn recall_clicked_30d_count_by_fact_id() {
        let tmp = TempDir::new().unwrap();
        let log = make_log(&tmp);

        // fact A 被点 3 次,fact B 被点 1 次
        for _ in 0..3 {
            log.append(
                &MetricsEvent::new(EventKind::RecallClicked)
                    .fact_id("A")
                    .query("pty"),
            );
        }
        log.append(
            &MetricsEvent::new(EventKind::RecallClicked)
                .fact_id("B")
                .query("gui"),
        );
        // 一条 31 天前的应被过滤
        let mut old = MetricsEvent::new(EventKind::RecallClicked).fact_id("A");
        old.ts = now_secs() - 31 * 86400;
        log.append(&old);

        let counts = log.count_recall_clicked_30d().unwrap();
        assert_eq!(counts.get("A").copied(), Some(3));
        assert_eq!(counts.get("B").copied(), Some(1));
    }

    #[test]
    fn today_proposes_only_within_today() {
        let tmp = TempDir::new().unwrap();
        let log = make_log(&tmp);

        let now = now_secs();
        // 1 小时前(今日内)
        let mut a = MetricsEvent::new(EventKind::Propose).author("x");
        a.ts = now - 3600;
        log.append(&a);
        // 2 天前(今日外,7 天内)
        let mut b = MetricsEvent::new(EventKind::Propose).author("x");
        b.ts = now - 2 * 86400;
        log.append(&b);

        let agg = log.aggregate_7d().unwrap();
        assert_eq!(agg.today_proposes, 1);
        // 7 天内 propose 总计是 2
        assert_eq!(agg.by_kind.get("propose").copied(), Some(2));
    }
}
