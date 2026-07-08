//! 存储层:facts/*.md (source of truth) + pending/*.md + SQLite FTS5 索引。
//!
//! 关键不变量(`.specops/specs/memory-design.md` §8):
//! 1. 唯一可变状态在 `MemoryStore`,外面用 `tokio::sync::Mutex` 包 → 写入串行
//! 2. 写入路径:tmp file → fsync → rename → SQLite 同事务 commit
//! 3. id 是 ULID,可排序文件名安全
//! 4. **agent 不能直接写 facts/**,必须走 propose → review approve
//! 5. FTS5 必须用 trigram tokenizer(unicode61 不分词中文)
//! 6. `vault/` 下的 markdown 是 source of truth;`.kode/` 下是私有索引(可重建)
//! 7. Obsidian-compat 布局:Obsidian 在 root/vault/ 打开,看不到 SQLite / budget
//! 8. reconcile 跳过任何无 frontmatter `id` 的 .md 文件(用户随手放的笔记不污染索引)

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fact::{Fact, FactMeta, Kind, Scope};
use crate::metrics::{EventKind, MetricsEvent, MetricsLog};

/// 可复用的检索 / 列表结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub author: String,
    pub scope: String,
    pub created: String,
    pub confidence: f32,
    pub tags: Vec<String>,
    pub snippet: String,
    pub score: f32,
    /// 2026-06+:种类(默认 `gotcha`)
    #[serde(default)]
    pub kind: String,
    /// 2026-06+:子系统(可空)
    #[serde(default)]
    pub subsystem: Option<String>,
    /// 2026-07+:人类可读标题
    #[serde(default)]
    pub title: Option<String>,
}

/// 检索过滤器(2026-06+)。所有字段都是可选叠加;空 = 不限制。
#[derive(Debug, Clone, Default)]
pub struct SearchFilter<'a> {
    /// 限定 scope(如 "project:kode" / "shared")
    pub scope: Option<&'a str>,
    /// 限定 kind 子集(空 = 全部)
    pub kinds: Vec<Kind>,
    /// 限定 subsystem(精确匹配,大小写敏感)
    pub subsystem: Option<&'a str>,
    /// 是否包含 deprecated
    pub include_deprecated: bool,
}

/// 全功能检索 opts(Phase 10.12+10.13)。
/// 与 `SearchFilter` 区别:`SearchFilter` 是历史字段(纯过滤),`SearchOpts` 多带
/// `query` / `top_k` / `current_path`(影响打分)。新代码用这个;`search()` / `search_filtered()`
/// 仍然在,内部转调 `search_with_opts`。
#[derive(Debug, Clone, Default)]
pub struct SearchOpts<'a> {
    pub query: &'a str,
    pub top_k: usize,
    pub scope: Option<&'a str>,
    pub kinds: Vec<Kind>,
    pub subsystem: Option<&'a str>,
    pub include_deprecated: bool,
    /// 当前编辑文件 / 当前 cwd 子路径,用于 `applies_to` glob 加分(×1.3)。
    /// 不传 = 不加分。
    pub current_path: Option<&'a str>,
}

/// 反链一条:谁引用了我。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Backlink {
    pub id: String,
    /// "supersedes" | "related" | "contradicts"
    pub kind: String,
    pub snippet: String,
}

/// `read_with_backlinks()` 返回的复合结构。给 GUI 详情页直接用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactWithBacklinks {
    pub fact: Fact,
    pub backlinks: Vec<Backlink>,
}

/// links 表三种 kind 的常量,避免拼写打错。
const LINK_SUPERSEDES: &str = "supersedes";
const LINK_RELATED: &str = "related";
const LINK_CONTRADICTS: &str = "contradicts";

/// 一条待审提议(从 pending/ 读出)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingFact {
    pub meta: FactMeta,
    pub body: String,
    /// agent 提议时给的"为什么提这条",仅用于 UI 展示,不进入 fact body
    pub rationale: Option<String>,
}

/// 用户审核 pending fact 的判决。
#[derive(Debug, Clone)]
pub enum Verdict {
    /// 直接通过
    Approve,
    /// 用户编辑后通过(可改 body / tags / scope / confidence + 双向链)
    EditThenApprove {
        body: Option<String>,
        tags: Option<Vec<String>>,
        scope: Option<Scope>,
        confidence: Option<f32>,
        /// Phase 10.10:approve 时由用户/LLM 助攻补的相关 fact ULID
        related: Option<Vec<String>>,
        /// Phase 10.10:与本条冲突的 fact ULID
        contradicts: Option<Vec<String>>,
        /// 2026-07+:用户编辑后的标题
        title: Option<String>,
    },
    /// 拒绝(归档,不进检索池)
    Reject { reason: String },
    /// 强拒绝(同时给 agent 强信号"以后别再写这种")
    Blacklist { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewOutcome {
    Approved,
    Rejected,
    Blacklisted,
}

/// propose 时检测到与现有 fact 高度重复。
///
/// **2026-06 改动**:
/// - top1 字段 (`existing_id` / `similarity` / `snippet`) 保留,兼容老调用方
/// - 新增 `candidates`:返回 top-N 命中,让 agent 自己看完再决策
///   - 选择 supersedes 替换某条
///   - 选择 force=true 强制写入(确认是不同语义、误判)
///   - 放弃这条
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateInfo {
    /// 最相似的一条 id(向后兼容字段;= candidates[0].id)
    pub existing_id: String,
    /// 最相似的一条得分
    pub similarity: f32,
    /// 最相似的一条摘要
    pub snippet: String,
    /// **2026-06+**:相似度倒序的 top-K 候选(K ≤ 5)。
    /// agent 应基于这一组判断是真重复还是误判 —— 单看 top1 易误拦。
    #[serde(default)]
    pub candidates: Vec<DuplicateCandidate>,
}

/// `DuplicateInfo.candidates` 的元素。
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateCandidate {
    pub id: String,
    pub similarity: f32,
    pub snippet: String,
    pub scope: String,
    pub tags: Vec<String>,
}

/// 重复检测的相似度阈值。
/// score = sigmoid(bm25) * 0.55 + confidence * 0.15 + recall * 0.10 + recency * 0.10 + path * 0.10
/// 完全相同 body → bm25 极负 → sigmoid≈1.0 → 总分接近 0.85+
/// 不同语义但有共享高频词的短文本 → 常落 0.40~0.65 区间
///
/// **历史**:0.50 太低,规则类短文本(都含「禁止/必须/项目」)语义不同也会被误拦
/// (见 2026-06 用户反馈)。提高到 0.75 后:
/// - 真重复(完全相同 / 仅大小写空格差异)仍被 A 路径(normalize 完全相等)拦下
/// - 近似但语义不同 → 不再硬拒,而是返回 `candidates` 让 agent 决策
/// 配合新增 `force` 参数,agent 可在确认误判时显式跳过查重而不需要 supersedes 覆盖。
const DUP_THRESHOLD: f32 = 0.75;
/// `DuplicateInfo.candidates` 返回的最大条数。
const DUP_CANDIDATES_K: usize = 5;
/// body 最大长度;超过让 LLM 拆成多条
pub const MAX_BODY_LEN: usize = 1000;

pub struct MemoryStore {
    root: PathBuf,
    conn: Connection,
    metrics: Arc<MetricsLog>,
}

impl MemoryStore {
    /// 在指定目录打开 / 初始化 store,启动时跑 reconcile。
    ///
    /// **2026-06 后的目录布局**(Obsidian-compat):
    /// ```text
    /// <root>/
    ///   vault/                     ← Obsidian 在这层打开 vault
    ///     facts/<id>.md            已审核,被检索   ← source of truth
    ///     pending/<id>.md          待审提议
    ///     .obsidian/               (用户加的 Obsidian 配置;reconcile 跳过)
    ///   .kode/                     ← 私有索引/能量(不进 vault,Obsidian 看不到)
    ///     index.sqlite             FTS5 索引(可重建)
    ///     budget.json              能量账本
    ///     metrics.jsonl            事件流(append-only)
    ///     archive/rejected/        被拒提议(保留,30 天清)
    ///     tmp/                     原子写暂存
    /// ```
    ///
    /// **老布局自动迁移**:若检测到旧的 `<root>/facts/` 而无 `<root>/vault/`,
    /// 一次性 mv:`facts/`→`vault/facts/` / `pending/`→`vault/pending/` /
    /// `archive/`→`.kode/archive/` / `tmp/`→`.kode/tmp/` / `index.sqlite`→`.kode/index.sqlite`。
    /// 迁移失败(中途崩)再次 open 也能续上。`budget.json` 由 `BudgetStore` 自己负责。
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();

        Self::migrate_legacy_layout(&root)?;

        std::fs::create_dir_all(facts_dir(&root))?;
        std::fs::create_dir_all(pending_dir(&root))?;
        std::fs::create_dir_all(archive_rejected_dir(&root))?;
        std::fs::create_dir_all(tmp_dir(&root))?;
        std::fs::create_dir_all(private_dir(&root))?;

        let db_path = sqlite_path(&root);
        let conn = Connection::open(&db_path).context("open sqlite")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS facts (
                id          TEXT PRIMARY KEY,
                author      TEXT NOT NULL,
                session     TEXT,
                scope       TEXT NOT NULL,
                created     TEXT NOT NULL,
                created_ts  INTEGER NOT NULL,
                confidence  REAL NOT NULL,
                tags        TEXT NOT NULL,
                supersedes  TEXT,
                ttl_days    INTEGER,
                deprecated  INTEGER NOT NULL DEFAULT 0,
                body        TEXT NOT NULL,
                kind        TEXT NOT NULL DEFAULT 'gotcha',
                subsystem   TEXT,
                applies_to  TEXT NOT NULL DEFAULT '[]',
                links       TEXT NOT NULL DEFAULT '[]',
                title       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, deprecated);
            CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_ts DESC);

            CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
                id UNINDEXED, body, tags,
                tokenize = 'trigram'
            );

            -- Phase 10.10:双向链表。每条 frontmatter 写 `related/contradicts/supersedes`,
            -- store 写入时同步同事务插入这张表;reconcile 时整表重建。
            -- 反链查询:`SELECT src_id, kind FROM links WHERE dst_id = ?`
            CREATE TABLE IF NOT EXISTS links (
                src_id TEXT NOT NULL,
                dst_id TEXT NOT NULL,
                kind   TEXT NOT NULL,
                PRIMARY KEY(src_id, dst_id, kind)
            );
            CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_id);
            "#,
        )?;

        // 兼容 v0 schema(无 kind 等列):ALTER 加列。
        // 必须在 CREATE INDEX(kind/subsystem)之前跑,否则索引建到不存在的列上。
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(facts)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();
        if !cols.iter().any(|c| c == "kind") {
            conn.execute(
                "ALTER TABLE facts ADD COLUMN kind TEXT NOT NULL DEFAULT 'gotcha'",
                [],
            )?;
        }
        if !cols.iter().any(|c| c == "subsystem") {
            conn.execute("ALTER TABLE facts ADD COLUMN subsystem TEXT", [])?;
        }
        if !cols.iter().any(|c| c == "applies_to") {
            conn.execute(
                "ALTER TABLE facts ADD COLUMN applies_to TEXT NOT NULL DEFAULT '[]'",
                [],
            )?;
        }
        if !cols.iter().any(|c| c == "links") {
            conn.execute(
                "ALTER TABLE facts ADD COLUMN links TEXT NOT NULL DEFAULT '[]'",
                [],
            )?;
        }
        // Phase 10.13:召回反馈环 + 时间衰减需要的 3 列
        if !cols.iter().any(|c| c == "recall_count_30d") {
            conn.execute(
                "ALTER TABLE facts ADD COLUMN recall_count_30d INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !cols.iter().any(|c| c == "recall_clicked_count_30d") {
            conn.execute(
                "ALTER TABLE facts ADD COLUMN recall_clicked_count_30d INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !cols.iter().any(|c| c == "last_recalled_at") {
            conn.execute("ALTER TABLE facts ADD COLUMN last_recalled_at INTEGER", [])?;
        }
        if !cols.iter().any(|c| c == "title") {
            conn.execute("ALTER TABLE facts ADD COLUMN title TEXT", [])?;
        }

        // 现在 kind/subsystem 列一定存在,可以建索引了
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind, deprecated);
            CREATE INDEX IF NOT EXISTS idx_facts_subsystem ON facts(subsystem) WHERE subsystem IS NOT NULL;
            "#,
        )?;

        let metrics = Arc::new(MetricsLog::open(&root).context("open metrics log")?);
        let mut store = Self {
            root,
            conn,
            metrics,
        };
        store.reconcile()?;
        Ok(store)
    }

    /// 暴露 metrics 句柄给上层(GUI / CLI)。`Arc` 让多线程克隆共享。
    pub fn metrics(&self) -> Arc<MetricsLog> {
        Arc::clone(&self.metrics)
    }

    /// 启动时把 facts/ 目录作为 source of truth,补齐 SQLite 缺失行。
    /// 目的:跨机同步(git pull facts/)后能恢复索引;崩溃后孤儿文件能恢复。
    /// 跳过任何无 frontmatter `id` 字段的 .md(用户在 vault 里随手加的笔记不应被索引)。
    ///
    /// **Phase 10.10**:同时重建 links 表(`DELETE` + 重新 INSERT supersedes/related/contradicts)。
    /// **legacy 字段迁移**:若 fact 的 `links` 非空且 `related` 为空 → 把 `links` 内容
    /// 平移到 `related`、清空 `links`、回写 markdown 文件。仅一次,迁移后下次 reconcile 不再触发。
    pub fn reconcile(&mut self) -> Result<usize> {
        let facts_dir_p = facts_dir(&self.root);
        let mut added = 0usize;

        // 现有索引中的 id 集合
        let mut existing: std::collections::HashSet<String> = {
            let mut stmt = self.conn.prepare("SELECT id FROM facts")?;
            let rows: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .filter_map(Result::ok)
                .collect();
            rows.into_iter().collect()
        };

        // Phase 10.10:整张 links 表清空,后面重新插入。
        // 不改 facts 表,只重建反链 — 这样即使 reconcile 中途崩,facts 仍是 source of truth。
        self.conn.execute("DELETE FROM links", [])?;

        for entry in std::fs::read_dir(&facts_dir_p)? {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !name.ends_with(".md") {
                continue;
            }
            // 关键:从 frontmatter 拿 id,而不是文件名 —— 用户可改文件名,
            // 也允许将来把文件名改成 `<ULID>--<slug>.md` 格式。
            let text = std::fs::read_to_string(&path)?;
            let mut fact = match Fact::from_markdown(&text) {
                Ok(f) => f,
                Err(_) => {
                    // 无 frontmatter 或缺 id —— 静默跳过(用户笔记不污染索引)
                    continue;
                }
            };

            // Phase 10.10 legacy 迁移:`links` 非空且 `related` 为空 → 平移并落盘
            let mut needs_rewrite = false;
            if !fact.meta.links.is_empty() && fact.meta.related.is_empty() {
                fact.meta.related = std::mem::take(&mut fact.meta.links);
                needs_rewrite = true;
            }
            if needs_rewrite {
                if let Ok(md) = fact.to_markdown() {
                    let _ = std::fs::write(&path, md);
                }
            }

            // 始终重建 links 行(整表清过)
            self.write_link_rows(&fact)?;

            if existing.remove(&fact.meta.id) {
                continue; // 已索引(facts 表)
            }
            self.insert_into_index(&fact)?;
            added += 1;
        }

        // 剩在 existing 里的是"SQLite 有、文件没"的孤儿,删掉索引(用户在 fs 上删了文件)
        for orphan in existing {
            self.conn
                .execute("DELETE FROM facts WHERE id = ?1", params![orphan])?;
            self.conn
                .execute("DELETE FROM facts_fts WHERE id = ?1", params![orphan])?;
        }
        Ok(added)
    }

    /// 把一条 fact 的 supersedes / related / contradicts 写入 `links` 表。
    /// 不删旧行 — 上层 reconcile 整表 DELETE 之后再来调,平时由 commit_to_facts 调用并先 DELETE 该 src_id。
    fn write_link_rows(&mut self, fact: &Fact) -> Result<()> {
        // 平时(非 reconcile)需要先清自己出度,避免重复积累
        self.conn
            .execute("DELETE FROM links WHERE src_id = ?1", params![fact.meta.id])?;
        if let Some(old) = &fact.meta.supersedes {
            self.conn.execute(
                "INSERT OR IGNORE INTO links(src_id, dst_id, kind) VALUES (?1, ?2, ?3)",
                params![fact.meta.id, old, LINK_SUPERSEDES],
            )?;
        }
        for r in &fact.meta.related {
            self.conn.execute(
                "INSERT OR IGNORE INTO links(src_id, dst_id, kind) VALUES (?1, ?2, ?3)",
                params![fact.meta.id, r, LINK_RELATED],
            )?;
        }
        for c in &fact.meta.contradicts {
            self.conn.execute(
                "INSERT OR IGNORE INTO links(src_id, dst_id, kind) VALUES (?1, ?2, ?3)",
                params![fact.meta.id, c, LINK_CONTRADICTS],
            )?;
        }
        Ok(())
    }

    /// 查询某条 fact 的反链(谁引用了我)。
    /// 返回顺序:先按 kind 字典序、再按 src_id ulid 时序(默认就近)。
    pub fn backlinks(&self, id: &str) -> Result<Vec<Backlink>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.src_id, l.kind, COALESCE(SUBSTR(f.body, 1, 160), '')
             FROM links l LEFT JOIN facts f ON f.id = l.src_id
             WHERE l.dst_id = ?1 AND (f.deprecated IS NULL OR f.deprecated = 0)
             ORDER BY l.kind, l.src_id",
        )?;
        let rows = stmt
            .query_map(params![id], |row| {
                Ok(Backlink {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    snippet: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ─── propose / pending pool ────────────────────────────────────────────

    /// agent 提议一条新 fact,进入 pending 队列。
    /// 不插入 facts 表 / FTS 索引;不可被 search 召回。
    /// 返回 pending fact 的 id;若与现有 fact 高度重复,返回 Err(DuplicateInfo).
    ///
    /// **2026-06**:新增 `force` 参数 ——
    /// - `false`(默认):走两层查重(完全相同 + FTS 近似 ≥ DUP_THRESHOLD),命中返回 candidates
    /// - `true`:跳过近似查重(`supersedes` 路径已经隐含跳过)。**A 路径(完全相同)仍然生效**:
    ///   normalize 后 body 完全相等的真重复仍会被拦,因为那一定是 agent 在搞事
    ///   而不是阈值误判。force 是给"语义不同但 embedding 拉不开距离"的情况。
    ///
    /// **2026-06**:新增 `kind` 参数 —— 显式指定 fact 种类
    /// (gotcha/invariant/recipe/dead_end/preference)。`None` 回落到 `Kind::default()`(gotcha)。
    pub fn propose(
        &mut self,
        author: &str,
        session: Option<&str>,
        scope: Scope,
        body: &str,
        tags: Vec<String>,
        supersedes: Option<String>,
        confidence: Option<f32>,
        rationale: Option<String>,
        force: bool,
        kind: Option<Kind>,
        title: Option<String>,
    ) -> Result<ProposeResult> {
        if body.len() > MAX_BODY_LEN {
            return Ok(ProposeResult::BodyTooLong {
                len: body.len(),
                max: MAX_BODY_LEN,
            });
        }

        // 重复检测有两层:
        //  A. body 完全相同(规范化后)→ 直接判 dup,**无视阈值,也无视 force**
        //     (force 是给"语义不同但 embedding 拉不开"的近似误判,完全相同不可能是误判)
        //  B. FTS5 语义近似 score ≥ DUP_THRESHOLD → 判 dup,带 candidates
        //     supersedes / force 任一为真时跳过 B,但仍跑 A
        if supersedes.is_none() {
            // A. 完全相同:遍历同 scope 已 deprecated=0 的 fact,比 body
            let normalized = normalize_body(body);
            let mut stmt = self
                .conn
                .prepare("SELECT id, body FROM facts WHERE scope = ?1 AND deprecated = 0")?;
            let rows: Vec<(String, String)> = stmt
                .query_map(params![scope.as_str()], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .filter_map(Result::ok)
                .collect();
            for (eid, ebody) in rows {
                if normalize_body(&ebody) == normalized {
                    let cand = DuplicateCandidate {
                        id: eid.clone(),
                        similarity: 1.0,
                        snippet: snippet_of(&ebody, "", 160),
                        scope: scope.as_str().to_string(),
                        tags: vec![],
                    };
                    return Ok(ProposeResult::Duplicate(DuplicateInfo {
                        existing_id: eid,
                        similarity: 1.0,
                        snippet: snippet_of(&ebody, "", 160),
                        candidates: vec![cand],
                    }));
                }
            }

            // B. FTS5 近似(force=true 时跳过)
            if !force {
                let scope_str = scope.as_str();
                let hits = self.search(body, Some(&scope_str), DUP_CANDIDATES_K, false)?;
                let above_threshold: Vec<_> = hits
                    .iter()
                    .filter(|h| h.score >= DUP_THRESHOLD)
                    .cloned()
                    .collect();
                if let Some(top) = above_threshold.first() {
                    let candidates: Vec<DuplicateCandidate> = above_threshold
                        .iter()
                        .map(|h| DuplicateCandidate {
                            id: h.id.clone(),
                            similarity: h.score,
                            snippet: h.snippet.clone(),
                            scope: h.scope.clone(),
                            tags: h.tags.clone(),
                        })
                        .collect();
                    return Ok(ProposeResult::Duplicate(DuplicateInfo {
                        existing_id: top.id.clone(),
                        similarity: top.score,
                        snippet: top.snippet.clone(),
                        candidates,
                    }));
                }
            }
        }

        let id = ulid::Ulid::new().to_string();
        let now_secs = now_secs();
        let created = format_rfc3339(now_secs);
        let title = normalize_or_derive_title(title, &tags, kind, body);
        let meta = FactMeta {
            id: id.clone(),
            author: author.to_string(),
            session: session.map(String::from),
            scope: scope.as_str(),
            created,
            confidence: confidence.unwrap_or(0.8),
            tags,
            title,
            supersedes,
            ttl_days: None,
            deprecated: false,
            kind: kind.unwrap_or_default(),
            subsystem: None,
            applies_to: vec![],
            links: vec![],
            related: vec![],
            contradicts: vec![],
            tried: None,
            failed_because: None,
            use_instead: None,
        };
        let pending = PendingFact {
            meta,
            body: body.to_string(),
            rationale,
        };

        let md = pending_to_markdown(&pending)?;
        let tmp = tmp_path(&self.root, &id);
        let final_path = pending_path(&self.root, &id);
        atomic_write(&tmp, &final_path, &md)?;

        // metrics:propose 成功才记 — 路径上面的 dup / too-long 早返回了
        self.metrics.append(
            &MetricsEvent::new(EventKind::Propose)
                .author(author)
                .scope(scope.as_str())
                .fact_id(&id),
        );

        Ok(ProposeResult::Accepted { id })
    }

    /// 列待审提议(给 UI / 用户工具用,agent 不应调)。
    pub fn list_pending(&self) -> Result<Vec<PendingFact>> {
        let dir = pending_dir(&self.root);
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let text = std::fs::read_to_string(&path)?;
            if let Ok(p) = pending_from_markdown(&text) {
                out.push(p);
            }
        }
        // 按 created 升序(老的先审)
        out.sort_by(|a, b| a.meta.created.cmp(&b.meta.created));
        Ok(out)
    }

    pub fn read_pending(&self, id: &str) -> Result<PendingFact> {
        let path = pending_path(&self.root, id);
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("read pending {}", path.display()))?;
        pending_from_markdown(&text)
    }

    /// 用户审核一条 pending。返回判决结果(给上层联动 budget 用)。
    pub fn review(&mut self, id: &str, verdict: Verdict) -> Result<ReviewOutcome> {
        let pending = self.read_pending(id)?;
        let author = pending.meta.author.clone();
        let scope = pending.meta.scope.clone();

        match verdict {
            Verdict::Approve => {
                let fact = Fact {
                    meta: pending.meta,
                    body: pending.body,
                };
                self.commit_to_facts(&fact)?;
                self.remove_pending_file(id)?;
                self.metrics.append(
                    &MetricsEvent::new(EventKind::Approve)
                        .author(&author)
                        .scope(&scope)
                        .fact_id(id),
                );
                Ok(ReviewOutcome::Approved)
            }
            Verdict::EditThenApprove {
                body,
                tags,
                scope: new_scope,
                confidence,
                related,
                contradicts,
                title: new_title,
            } => {
                let mut meta = pending.meta;
                if let Some(t) = tags {
                    meta.tags = t;
                }
                if let Some(s) = new_scope {
                    meta.scope = s.as_str();
                }
                if let Some(c) = confidence {
                    meta.confidence = c;
                }
                if let Some(r) = related {
                    meta.related = r;
                }
                if let Some(c) = contradicts {
                    meta.contradicts = c;
                }
                if let Some(t) = new_title {
                    meta.title = Some(t);
                }
                let body = body.unwrap_or(pending.body);
                let final_scope = meta.scope.clone();
                let fact = Fact { meta, body };
                self.commit_to_facts(&fact)?;
                self.remove_pending_file(id)?;
                self.metrics.append(
                    &MetricsEvent::new(EventKind::EditThenApprove)
                        .author(&author)
                        .scope(&final_scope)
                        .fact_id(id),
                );
                Ok(ReviewOutcome::Approved)
            }
            Verdict::Reject { reason } => {
                self.archive_rejected(id, &reason, &pending)?;
                self.remove_pending_file(id)?;
                self.metrics.append(
                    &MetricsEvent::new(EventKind::Reject)
                        .author(&author)
                        .scope(&scope)
                        .fact_id(id)
                        .reason(&reason),
                );
                Ok(ReviewOutcome::Rejected)
            }
            Verdict::Blacklist { reason } => {
                self.archive_rejected(id, &format!("BLACKLIST: {}", reason), &pending)?;
                self.remove_pending_file(id)?;
                self.metrics.append(
                    &MetricsEvent::new(EventKind::Blacklist)
                        .author(&author)
                        .scope(&scope)
                        .fact_id(id)
                        .reason(&reason),
                );
                Ok(ReviewOutcome::Blacklisted)
            }
        }
    }

    /// 内部:把一条 fact 落入 facts/ + SQLite。原子 + 处理 supersedes。
    fn commit_to_facts(&mut self, fact: &Fact) -> Result<()> {
        // 1. 文件原子写
        let md = fact.to_markdown()?;
        let tmp = tmp_path(&self.root, &fact.meta.id);
        let final_path = fact_path(&self.root, &fact.meta.id, fact.meta.title.as_deref());
        atomic_write(&tmp, &final_path, &md)?;

        // 2. SQLite 同事务插入 + 顺手 deprecate 老 fact
        self.insert_into_index(fact)?;
        // 3. links 表(supersedes / related / contradicts)
        self.write_link_rows(fact)?;
        if let Some(old_id) = &fact.meta.supersedes {
            // 同时让老 fact 的文件 frontmatter 也反映 deprecated 状态
            let _ = self.deprecate_silent(old_id, "superseded");
        }
        Ok(())
    }

    /// 把 fact 插入 SQLite + FTS;不动文件。
    fn insert_into_index(&mut self, fact: &Fact) -> Result<()> {
        let tx = self.conn.transaction()?;
        let tags_json = serde_json::to_string(&fact.meta.tags)?;
        let applies_to_json = serde_json::to_string(&fact.meta.applies_to)?;
        let links_json = serde_json::to_string(&fact.meta.links)?;
        let created_ts = parse_rfc3339_secs(&fact.meta.created).unwrap_or_else(now_secs) as i64;
        tx.execute(
            "INSERT OR REPLACE INTO facts(id, author, session, scope, created, created_ts, confidence, tags, supersedes, ttl_days, deprecated, body, kind, subsystem, applies_to, links, title)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                fact.meta.id,
                fact.meta.author,
                fact.meta.session,
                fact.meta.scope,
                fact.meta.created,
                created_ts,
                fact.meta.confidence,
                tags_json,
                fact.meta.supersedes,
                fact.meta.ttl_days,
                fact.meta.deprecated as i64,
                fact.body,
                fact.meta.kind.as_str(),
                fact.meta.subsystem,
                applies_to_json,
                links_json,
                fact.meta.title,
            ],
        )?;
        tx.execute("DELETE FROM facts_fts WHERE id = ?1", params![fact.meta.id])?;
        tx.execute(
            "INSERT INTO facts_fts(id, body, tags) VALUES (?1, ?2, ?3)",
            params![fact.meta.id, fact.body, fact.meta.tags.join(" ")],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 同时更新文件 frontmatter 与 SQLite 把 fact 标 deprecated(用户调)。
    pub fn deprecate(&mut self, id: &str, reason: &str) -> Result<()> {
        self.conn
            .execute("UPDATE facts SET deprecated = 1 WHERE id = ?1", params![id])?;
        let mut fact = self.read(id)?;
        fact.meta.deprecated = true;
        fact.body
            .push_str(&format!("\n\n<!-- deprecated: {} -->", reason));
        let md = fact.to_markdown()?;
        self.remove_old_fact_file(id)?;
        let path = fact_path(&self.root, id, fact.meta.title.as_deref());
        std::fs::write(&path, md)?;

        self.metrics.append(
            &MetricsEvent::new(EventKind::Deprecate)
                .fact_id(id)
                .reason(reason),
        );
        Ok(())
    }

    /// 修改已 approve fact 的 scope(文件 frontmatter + SQLite 同步)。
    /// 用户在 GUI Browse 面板手动把 project-scoped fact 提升为 global/shared。
    pub fn update_scope(&mut self, id: &str, new_scope: Scope) -> Result<()> {
        let scope_str = new_scope.as_str();
        self.conn.execute(
            "UPDATE facts SET scope = ?1 WHERE id = ?2",
            params![scope_str, id],
        )?;
        let mut fact = self.read(id)?;
        fact.meta.scope = scope_str.clone();
        let md = fact.to_markdown()?;
        self.remove_old_fact_file(id)?;
        let path = fact_path(&self.root, id, fact.meta.title.as_deref());
        std::fs::write(&path, md)?;
        Ok(())
    }

    /// commit_to_facts 内部用的"安静版" deprecate(supersedes 触发,失败不致命)
    fn deprecate_silent(&mut self, id: &str, reason: &str) -> Result<()> {
        let _ = self
            .conn
            .execute("UPDATE facts SET deprecated = 1 WHERE id = ?1", params![id]);
        if let Ok(mut fact) = self.read(id) {
            fact.meta.deprecated = true;
            fact.body
                .push_str(&format!("\n\n<!-- deprecated: {} -->", reason));
            if let Ok(md) = fact.to_markdown() {
                let _ = self.remove_old_fact_file(id);
                let path = fact_path(&self.root, id, fact.meta.title.as_deref());
                let _ = std::fs::write(&path, md);
            }
        }
        Ok(())
    }

    fn archive_rejected(&self, id: &str, reason: &str, pending: &PendingFact) -> Result<()> {
        let mut p = pending.clone();
        p.rationale = Some(format!(
            "{}\n[rejected: {}]",
            p.rationale.unwrap_or_default(),
            reason
        ));
        let md = pending_to_markdown(&p)?;
        let path = archive_rejected_dir(&self.root).join(format!("{}.md", id));
        std::fs::write(&path, md)?;
        Ok(())
    }

    fn remove_pending_file(&self, id: &str) -> Result<()> {
        let path = pending_path(&self.root, id);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    // ─── 检索(对 facts/,不含 pending)──────────────────────────────────

    pub fn read(&self, id: &str) -> Result<Fact> {
        let path = self.resolve_fact_path(id).with_context(|| {
            format!(
                "fact {} not found in {}",
                id,
                facts_dir(&self.root).display()
            )
        })?;
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("read fact {}", path.display()))?;
        Fact::from_markdown(&text)
    }

    /// 根据 id 在 facts/ 目录下找到文件(兼容 {id}.md 和 {id}-{slug}.md)。
    fn resolve_fact_path(&self, id: &str) -> Option<PathBuf> {
        let dir = facts_dir(&self.root);
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") {
                continue;
            }
            if name == format!("{}.md", id) {
                return Some(entry.path());
            }
            if name.starts_with(id) {
                let rest = &name[id.len()..];
                if rest.starts_with('-') && rest.ends_with(".md") {
                    return Some(entry.path());
                }
            }
        }
        None
    }

    /// 删除某 id 对应的旧 fact 文件(所有可能的命名格式)。
    /// 用于 title 变更导致文件名变化时清理旧文件。
    fn remove_old_fact_file(&self, id: &str) -> Result<()> {
        let dir = facts_dir(&self.root);
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") {
                continue;
            }
            if name == format!("{}.md", id) {
                std::fs::remove_file(entry.path())?;
            }
            if name.starts_with(id) {
                let rest = &name[id.len()..];
                if rest.starts_with('-') && rest.ends_with(".md") {
                    std::fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }

    /// Phase 10.10:读 fact + 反链。给 GUI 详情页用。
    /// 反链查 `links` 表 — `read()` 不带反链是为了保留快路径。
    pub fn read_with_backlinks(&self, id: &str) -> Result<FactWithBacklinks> {
        let fact = self.read(id)?;
        let backlinks = self.backlinks(id)?;
        Ok(FactWithBacklinks { fact, backlinks })
    }

    /// Phase 10.13:用户在 GUI 点击了某条搜索结果 = 反馈"这条有用"。
    /// 1. SQLite 累加 `recall_clicked_count_30d` + 设 `last_recalled_at`(下次启动同步会重算)
    /// 2. 写 metrics(`recall_clicked`)— 后台聚合 task 也会用同一份数据
    /// 3. 不动文件
    pub fn bump_recall(&mut self, id: &str, query: Option<&str>) -> Result<()> {
        let now = now_secs() as i64;
        // 用 max(0, +1) 保证不出现奇怪的负数;UPDATE 不存在的 id 不报错。
        self.conn.execute(
            "UPDATE facts SET recall_clicked_count_30d = recall_clicked_count_30d + 1,
                              last_recalled_at = ?2
             WHERE id = ?1",
            params![id, now],
        )?;
        let mut ev = MetricsEvent::new(EventKind::RecallClicked).fact_id(id);
        if let Some(q) = query {
            ev = ev.query(q);
        }
        self.metrics.append(&ev);
        Ok(())
    }

    /// **Phase 10.13** 后台聚合:从 metrics.jsonl 读最近 30 天 `recall_clicked` 事件,
    /// UPSERT 进 facts 表的 `recall_clicked_count_30d` 列。GUI 启动 + 每小时跑一次。
    /// 返回更新的 fact 数。
    pub fn aggregate_recall_30d(&mut self) -> Result<usize> {
        let counts = self
            .metrics
            .count_recall_clicked_30d()
            .context("read recall_clicked from metrics")?;
        // 先把全表 recall_clicked_count_30d 清 0(确保 31 天前的点击不再算),再 UPSERT
        self.conn
            .execute("UPDATE facts SET recall_clicked_count_30d = 0", [])?;
        let mut updated = 0usize;
        for (id, n) in counts {
            let r = self.conn.execute(
                "UPDATE facts SET recall_clicked_count_30d = ?2 WHERE id = ?1",
                params![id, n as i64],
            )?;
            updated += r;
        }
        Ok(updated)
    }

    pub fn search(
        &self,
        query: &str,
        scope: Option<&str>,
        top_k: usize,
        include_deprecated: bool,
    ) -> Result<Vec<SearchHit>> {
        self.search_with_opts(&SearchOpts {
            query,
            top_k,
            scope,
            include_deprecated,
            ..Default::default()
        })
    }

    /// 旧 `search_filtered` 也保留(`SearchFilter` 不带 query/top_k,内部转 SearchOpts)。
    pub fn search_filtered(
        &self,
        query: &str,
        top_k: usize,
        filter: &SearchFilter<'_>,
    ) -> Result<Vec<SearchHit>> {
        self.search_with_opts(&SearchOpts {
            query,
            top_k,
            scope: filter.scope,
            kinds: filter.kinds.clone(),
            subsystem: filter.subsystem,
            include_deprecated: filter.include_deprecated,
            current_path: None,
        })
    }

    /// **Phase 10.12 + 10.13** 全功能检索。
    /// 打分公式:
    /// ```text
    /// score = bm25_norm * 0.55
    ///       + confidence * 0.15
    ///       + log(recall_clicked + 1) * 0.10
    ///       + recency_decay(created, half_life=180d) * 0.10
    ///       + path_match_bonus * 0.10        // applies_to 命中 current_path → 1.0;否则 0
    /// ```
    /// 各分项归一到 [0,1] 量级。bm25_norm 用 sigmoid(-bm25)(SQLite bm25 越负越好)。
    ///
    /// **短 query 兜底**:trigram tokenizer 要求 ≥ 3 字符才能命中 ——
    /// query 长度 < 3 时(如 "ui" / "go" / "rs")FTS5 永远 0 召回。
    /// 这种情况直接走 LIKE `%query%` 子串扫描 + 简化打分,UX 上比"查不到"友好。
    pub fn search_with_opts(&self, opts: &SearchOpts<'_>) -> Result<Vec<SearchHit>> {
        // 短 query 走 fallback,所有过滤维度仍生效但打分简化
        let q_trimmed = opts.query.trim();
        let needs_fallback = q_trimmed.chars().count() < 3 && !q_trimmed.is_empty();
        if needs_fallback {
            return self.search_short_query_fallback(opts, q_trimmed);
        }

        let fts_query = sanitize_fts_query(opts.query);

        // 动态 SQL:WHERE 子句按 filter 拼,占位符 ?N 索引也跟着变。
        let mut sql = String::from(
            "SELECT f.id, f.author, f.scope, f.created, f.created_ts, f.confidence, f.tags, f.body,
	                    f.kind, f.subsystem, f.applies_to, f.recall_clicked_count_30d,
	                    f.title, bm25(facts_fts) AS score
	             FROM facts_fts JOIN facts f ON f.id = facts_fts.id
	             WHERE facts_fts MATCH ?1",
        );
        let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(fts_query)];

        if !opts.include_deprecated {
            sql.push_str(" AND f.deprecated = 0");
        }
        if let Some(sc) = opts.scope {
            bindings.push(Box::new(sc.to_string()));
            sql.push_str(&format!(" AND f.scope = ?{}", bindings.len()));
        }
        if !opts.kinds.is_empty() {
            // IN 子句
            let placeholders: Vec<String> = opts
                .kinds
                .iter()
                .map(|k| {
                    bindings.push(Box::new(k.as_str().to_string()));
                    format!("?{}", bindings.len())
                })
                .collect();
            sql.push_str(&format!(" AND f.kind IN ({})", placeholders.join(",")));
        }
        if let Some(sub) = opts.subsystem {
            bindings.push(Box::new(sub.to_string()));
            sql.push_str(&format!(" AND f.subsystem = ?{}", bindings.len()));
        }

        // 注意:**先**按 BM25 取一批候选,**后**重新打分。这里取 max(top_k * 4, 32) 让重排有空间。
        let raw_limit = opts.top_k.saturating_mul(4).max(32);
        bindings.push(Box::new(raw_limit as i64));
        sql.push_str(&format!(" ORDER BY score ASC LIMIT ?{}", bindings.len()));

        let mut stmt = self.conn.prepare(&sql)?;
        let now = now_secs() as i64;
        let current_path = opts.current_path.unwrap_or("");
        let query_str = opts.query.to_string();

        let mapper = |row: &rusqlite::Row| -> rusqlite::Result<SearchHit> {
            let tags_json: String = row.get(6)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            let body: String = row.get(7)?;
            let kind: String = row.get(8)?;
            let subsystem: Option<String> = row.get(9)?;
            let applies_to_json: String = row.get(10)?;
            let applies_to: Vec<String> =
                serde_json::from_str(&applies_to_json).unwrap_or_default();
            let recall_clicked: i64 = row.get(11)?;
            let title: Option<String> = row.get(12)?;
            let bm25_score: f64 = row.get(13)?;
            let confidence: f32 = row.get(5)?;
            let created_ts: i64 = row.get(4)?;

            let bm25_norm = 1.0 / (1.0 + (bm25_score as f32).exp());
            let recall_term = ((recall_clicked.max(0) as f32) + 1.0).ln() / 5.0_f32.ln(); // 归一,假设上限~5次
            let recall_term = recall_term.min(1.0);
            let age_secs = (now - created_ts).max(0) as f32;
            let age_days = age_secs / 86400.0;
            let recency = 0.5_f32.powf(age_days / 180.0); // 180 天半衰期
            let path_bonus =
                if !current_path.is_empty() && glob_match_any(&applies_to, current_path) {
                    1.0
                } else {
                    0.0
                };

            let score = bm25_norm * 0.55
                + confidence * 0.15
                + recall_term * 0.10
                + recency * 0.10
                + path_bonus * 0.10;

            Ok(SearchHit {
                id: row.get(0)?,
                author: row.get(1)?,
                scope: row.get(2)?,
                created: row.get(3)?,
                confidence,
                tags,
                snippet: snippet_of(&body, &query_str, 160),
                score,
                kind,
                subsystem,
                title,
            })
        };

        let params_refs: Vec<&dyn rusqlite::ToSql> = bindings.iter().map(|b| b.as_ref()).collect();
        let mut rows: Vec<SearchHit> = stmt
            .query_map(params_refs.as_slice(), mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        rows.truncate(opts.top_k);

        // metrics 埋点 — 写 search 事件(top_k 是返回数量,不是请求数量)
        let mut ev = MetricsEvent::new(EventKind::Search)
            .query(&query_str)
            .top_k(rows.len());
        if let Some(sc) = opts.scope {
            ev = ev.scope(sc);
        }
        self.metrics.append(&ev);

        Ok(rows)
    }

    /// 短 query 兜底:LIKE `%q%` on body / tags。
    /// FTS5 trigram tokenizer 要求 ≥ 3 字符,query 短于 3 字符时 FTS 永远 0 命中,
    /// 这里改用 SQL LIKE 子串扫描。性能在 < 1 万条规模可接受;打分简化为
    /// `confidence * 0.4 + recency * 0.3 + recall_bonus * 0.2 + path_bonus * 0.1`,
    /// **没有 BM25 词频信号**,仅给"是否 substring 命中"+元数据排序。
    fn search_short_query_fallback(
        &self,
        opts: &SearchOpts<'_>,
        q: &str,
    ) -> Result<Vec<SearchHit>> {
        // SQL LIKE 模式:转义 % _ \,然后包 %…%
        // 简单起见,我们要求 q 不能含 SQL 通配符;含的话直接当字面量(LIKE ESCAPE)
        let escaped = q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{}%", escaped);

        let mut sql = String::from(
            "SELECT f.id, f.author, f.scope, f.created, f.created_ts, f.confidence, f.tags, f.body,
	                    f.kind, f.subsystem, f.applies_to, f.recall_clicked_count_30d, f.title
	             FROM facts f
	             WHERE (f.body LIKE ?1 ESCAPE '\\' OR f.tags LIKE ?1 ESCAPE '\\')",
        );
        let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(pattern)];

        if !opts.include_deprecated {
            sql.push_str(" AND f.deprecated = 0");
        }
        if let Some(sc) = opts.scope {
            bindings.push(Box::new(sc.to_string()));
            sql.push_str(&format!(" AND f.scope = ?{}", bindings.len()));
        }
        if !opts.kinds.is_empty() {
            let placeholders: Vec<String> = opts
                .kinds
                .iter()
                .map(|k| {
                    bindings.push(Box::new(k.as_str().to_string()));
                    format!("?{}", bindings.len())
                })
                .collect();
            sql.push_str(&format!(" AND f.kind IN ({})", placeholders.join(",")));
        }
        if let Some(sub) = opts.subsystem {
            bindings.push(Box::new(sub.to_string()));
            sql.push_str(&format!(" AND f.subsystem = ?{}", bindings.len()));
        }
        // 短 query 召回多 → 上限稍大,后面再 truncate
        let raw_limit = opts.top_k.saturating_mul(4).max(64);
        bindings.push(Box::new(raw_limit as i64));
        sql.push_str(&format!(" LIMIT ?{}", bindings.len()));

        let mut stmt = self.conn.prepare(&sql)?;
        let now = now_secs() as i64;
        let current_path = opts.current_path.unwrap_or("");
        let query_str = q.to_string();

        let params_refs: Vec<&dyn rusqlite::ToSql> = bindings.iter().map(|b| b.as_ref()).collect();
        let mut rows: Vec<SearchHit> = stmt
            .query_map(params_refs.as_slice(), |row| {
                let tags_json: String = row.get(6)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                let body: String = row.get(7)?;
                let kind: String = row.get(8)?;
                let subsystem: Option<String> = row.get(9)?;
                let applies_to_json: String = row.get(10)?;
                let applies_to: Vec<String> =
                    serde_json::from_str(&applies_to_json).unwrap_or_default();
                let recall_clicked: i64 = row.get(11)?;
                let title: Option<String> = row.get(12)?;
                let confidence: f32 = row.get(5)?;
                let created_ts: i64 = row.get(4)?;

                let recall_term = ((recall_clicked.max(0) as f32) + 1.0).ln() / 5.0_f32.ln();
                let recall_term = recall_term.min(1.0);
                let age_secs = (now - created_ts).max(0) as f32;
                let age_days = age_secs / 86400.0;
                let recency = 0.5_f32.powf(age_days / 180.0);
                let path_bonus =
                    if !current_path.is_empty() && glob_match_any(&applies_to, current_path) {
                        1.0
                    } else {
                        0.0
                    };
                // 短 query 没有 BM25 — 用 confidence 占 40% 当主信号
                let score =
                    confidence * 0.40 + recency * 0.30 + recall_term * 0.20 + path_bonus * 0.10;

                Ok(SearchHit {
                    id: row.get(0)?,
                    author: row.get(1)?,
                    scope: row.get(2)?,
                    created: row.get(3)?,
                    confidence,
                    tags,
                    snippet: snippet_of(&body, &query_str, 160),
                    score,
                    kind,
                    subsystem,
                    title,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        rows.truncate(opts.top_k);

        // metrics 同样埋点(标记走了 fallback — 用 query 字段保留原文,top_k 是返回数)
        let mut ev = MetricsEvent::new(EventKind::Search)
            .query(&query_str)
            .top_k(rows.len());
        if let Some(sc) = opts.scope {
            ev = ev.scope(sc);
        }
        self.metrics.append(&ev);

        Ok(rows)
    }

    pub fn list_recent(&self, scope: Option<&str>, since_hours: u64) -> Result<Vec<SearchHit>> {
        let cutoff = now_secs().saturating_sub(since_hours * 3600);

        let (sql, params_vec): (&str, Vec<Box<dyn rusqlite::ToSql>>) = if let Some(sc) = scope {
            (
                "SELECT id, author, scope, created, confidence, tags, body, kind, subsystem, title
                 FROM facts WHERE created_ts >= ?1 AND deprecated = 0 AND scope = ?2
                 ORDER BY created_ts DESC LIMIT 100",
                vec![Box::new(cutoff as i64), Box::new(sc.to_string())],
            )
        } else {
            (
                "SELECT id, author, scope, created, confidence, tags, body, kind, subsystem, title
                 FROM facts WHERE created_ts >= ?1 AND deprecated = 0
                 ORDER BY created_ts DESC LIMIT 100",
                vec![Box::new(cutoff as i64)],
            )
        };

        let mut stmt = self.conn.prepare(sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(params_refs.as_slice(), |row| {
                let tags_json: String = row.get(5)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                let body: String = row.get(6)?;
                Ok(SearchHit {
                    id: row.get(0)?,
                    author: row.get(1)?,
                    scope: row.get(2)?,
                    created: row.get(3)?,
                    confidence: row.get(4)?,
                    tags,
                    snippet: snippet_of(&body, "", 160),
                    score: 1.0,
                    kind: row.get(7)?,
                    subsystem: row.get(8)?,
                    title: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 列出所有非 deprecated fact 出现过的 distinct scope(字典序)。
    /// GUI Browse 面板用它构建「按项目过滤」下拉。
    pub fn distinct_scopes(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT scope FROM facts WHERE deprecated = 0 ORDER BY scope")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn count(&self) -> Result<i64> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))?;
        Ok(n)
    }

    pub fn count_pending(&self) -> Result<usize> {
        let dir = pending_dir(&self.root);
        let mut n = 0;
        for entry in std::fs::read_dir(&dir)? {
            let p = entry?.path();
            if p.extension().and_then(|s| s.to_str()) == Some("md") {
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// **测试专用**:绕过 propose+review 直接落入 facts/。
    /// 仅用于 baseline 数据集 / 集成测试种子,**生产代码勿调**。
    #[doc(hidden)]
    pub fn write_for_test(
        &mut self,
        author: &str,
        session: Option<&str>,
        scope: Scope,
        body: &str,
        tags: Vec<String>,
        confidence: Option<f32>,
    ) -> Result<String> {
        self.write_for_test_full(
            author,
            session,
            scope,
            body,
            tags,
            confidence,
            Kind::default(),
            None,
            vec![],
            vec![],
        )
    }

    /// **测试专用**:全字段版本(带 kind / subsystem / applies_to / links)。
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn write_for_test_full(
        &mut self,
        author: &str,
        session: Option<&str>,
        scope: Scope,
        body: &str,
        tags: Vec<String>,
        confidence: Option<f32>,
        kind: Kind,
        subsystem: Option<String>,
        applies_to: Vec<String>,
        links: Vec<String>,
    ) -> Result<String> {
        let id = ulid::Ulid::new().to_string();
        let now = now_secs();
        let fact = Fact {
            meta: FactMeta {
                id: id.clone(),
                author: author.to_string(),
                session: session.map(String::from),
                scope: scope.as_str(),
                created: format_rfc3339(now),
                confidence: confidence.unwrap_or(0.8),
                tags,
                title: None,
                supersedes: None,
                ttl_days: None,
                deprecated: false,
                kind,
                subsystem,
                applies_to,
                links,
                related: vec![],
                contradicts: vec![],
                tried: None,
                failed_because: None,
                use_instead: None,
            },
            body: body.to_string(),
        };
        self.commit_to_facts(&fact)?;
        Ok(id)
    }
}

#[derive(Debug)]
pub enum ProposeResult {
    Accepted { id: String },
    Duplicate(DuplicateInfo),
    BodyTooLong { len: usize, max: usize },
}

// ─── 路径布局 helpers(2026-06 Obsidian-compat 后) ─────────────────────────
//
// vault/   = Obsidian 看到的部分(facts + pending + 用户笔记)
// .kode/   = 私有索引/能量/archive/tmp(Obsidian 用 .gitignore 风格隐藏)
//
// 加新路径时:**一律走这些 helper**,不要散写 root.join(...)。

pub(crate) fn vault_dir(root: &Path) -> PathBuf {
    root.join("vault")
}

pub fn private_dir(root: &Path) -> PathBuf {
    root.join(".kode")
}

pub(crate) fn facts_dir(root: &Path) -> PathBuf {
    vault_dir(root).join("facts")
}

pub(crate) fn pending_dir(root: &Path) -> PathBuf {
    vault_dir(root).join("pending")
}

pub(crate) fn fact_path(root: &Path, id: &str, title: Option<&str>) -> PathBuf {
    let slug = crate::fact::slug_from_title(title);
    if slug.is_empty() {
        facts_dir(root).join(format!("{}.md", id))
    } else {
        facts_dir(root).join(format!("{}-{}.md", id, slug))
    }
}

fn normalize_or_derive_title(
    title: Option<String>,
    tags: &[String],
    kind: Option<Kind>,
    body: &str,
) -> Option<String> {
    if let Some(t) = title
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Some(t.chars().take(80).collect());
    }

    let tag_words: Vec<String> = tags
        .iter()
        .filter_map(|tag| ascii_title_token(tag))
        .take(4)
        .collect();
    if !tag_words.is_empty() {
        return Some(tag_words.join(" "));
    }

    let body_words: Vec<String> = body
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(ascii_title_token)
        .take(6)
        .collect();
    if !body_words.is_empty() {
        return Some(body_words.join(" "));
    }

    kind.map(|k| k.as_str().replace('_', " "))
}

fn ascii_title_token(s: &str) -> Option<String> {
    let token = s
        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_ascii_lowercase();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

pub(crate) fn pending_path(root: &Path, id: &str) -> PathBuf {
    pending_dir(root).join(format!("{}.md", id))
}

pub(crate) fn tmp_dir(root: &Path) -> PathBuf {
    private_dir(root).join("tmp")
}

pub(crate) fn tmp_path(root: &Path, id: &str) -> PathBuf {
    tmp_dir(root).join(format!("{}.md.tmp", id))
}

pub(crate) fn archive_rejected_dir(root: &Path) -> PathBuf {
    private_dir(root).join("archive").join("rejected")
}

pub(crate) fn sqlite_path(root: &Path) -> PathBuf {
    private_dir(root).join("index.sqlite")
}

impl MemoryStore {
    /// 检测老布局(`<root>/facts/`)且无新布局(`<root>/vault/`)→ 一次性迁移。
    /// 幂等:中途崩溃后再次 open 也能继续。
    fn migrate_legacy_layout(root: &Path) -> Result<()> {
        let new_vault = vault_dir(root);
        let old_facts = root.join("facts");
        let old_pending = root.join("pending");
        let old_archive = root.join("archive");
        let old_tmp = root.join("tmp");
        let old_sqlite = root.join("index.sqlite");
        let old_sqlite_wal = root.join("index.sqlite-wal");
        let old_sqlite_shm = root.join("index.sqlite-shm");
        let old_budget = root.join("budget.json");

        // 触发条件:老 facts 存在 & 新 vault 不存在
        if !old_facts.exists() || new_vault.exists() {
            return Ok(());
        }

        tracing::info!(
            "kode-memory: migrating legacy layout at {} -> vault/ + .kode/",
            root.display()
        );

        std::fs::create_dir_all(&new_vault).context("create vault/")?;
        let new_priv = private_dir(root);
        std::fs::create_dir_all(&new_priv).context("create .kode/")?;

        // 单个 rename 失败要直接 bail —— 半迁移状态比不迁更差
        let move_dir = |from: &Path, to: &Path| -> Result<()> {
            if from.exists() {
                std::fs::rename(from, to)
                    .with_context(|| format!("mv {} -> {}", from.display(), to.display()))?;
            }
            Ok(())
        };

        move_dir(&old_facts, &new_vault.join("facts"))?;
        move_dir(&old_pending, &new_vault.join("pending"))?;
        move_dir(&old_archive, &new_priv.join("archive"))?;
        move_dir(&old_tmp, &new_priv.join("tmp"))?;
        move_dir(&old_sqlite, &new_priv.join("index.sqlite"))?;
        move_dir(&old_sqlite_wal, &new_priv.join("index.sqlite-wal"))?;
        move_dir(&old_sqlite_shm, &new_priv.join("index.sqlite-shm"))?;
        move_dir(&old_budget, &new_priv.join("budget.json"))?;

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingFrontmatter {
    #[serde(flatten)]
    meta: FactMeta,
    #[serde(default)]
    rationale: Option<String>,
}

fn pending_to_markdown(p: &PendingFact) -> Result<String> {
    let fm = PendingFrontmatter {
        meta: p.meta.clone(),
        rationale: p.rationale.clone(),
    };
    let yaml = serde_yaml::to_string(&fm)?;
    Ok(format!("---\n{}---\n{}\n", yaml, p.body.trim_end()))
}

fn pending_from_markdown(text: &str) -> Result<PendingFact> {
    // 复用 Fact::from_markdown 的 splitter,但反序列化用 PendingFrontmatter
    let text = text.trim_start();
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| anyhow::anyhow!("pending: missing frontmatter opener"))?;
    let mut idx = 0;
    let (yaml, body) = loop {
        let line_end = rest[idx..]
            .find('\n')
            .map(|p| idx + p + 1)
            .unwrap_or(rest.len());
        let line = &rest[idx..line_end];
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" {
            break (&rest[..idx], &rest[line_end..]);
        }
        if line_end == rest.len() {
            return Err(anyhow::anyhow!("pending: missing frontmatter closer"));
        }
        idx = line_end;
    };
    let fm: PendingFrontmatter = serde_yaml::from_str(yaml)?;
    Ok(PendingFact {
        meta: fm.meta,
        body: body.trim().to_string(),
        rationale: fm.rationale,
    })
}

// ─── 原子写助手 ───────────────────────────────────────────────────────────

fn atomic_write(tmp: &Path, final_path: &Path, content: &str) -> Result<()> {
    use std::io::Write;
    let mut f =
        std::fs::File::create(tmp).with_context(|| format!("create tmp {}", tmp.display()))?;
    f.write_all(content.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(tmp, final_path).context("rename tmp -> final")?;
    Ok(())
}

// ─── FTS5 query 处理 ──────────────────────────────────────────────────────

fn sanitize_fts_query(q: &str) -> String {
    let tokens: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric() && !is_cjk(c))
        .filter(|t| !t.is_empty())
        .filter(|t| t.chars().count() >= 1) // trigram 内部需要 ≥3 字符,这里宽松
        .map(|t| format!("\"{}\"", t.replace('"', "")))
        .collect();
    if tokens.is_empty() {
        "\"___no_match___\"".to_string()
    } else {
        tokens.join(" OR ")
    }
}

/// Phase 10.12:`applies_to` 的任一 glob 命中 `path` 即返回 true。
/// 失败的 pattern 静默跳过 — 用户写错 glob 不该让 search 全挂。
fn glob_match_any(patterns: &[String], path: &str) -> bool {
    if patterns.is_empty() || path.is_empty() {
        return false;
    }
    for pat in patterns {
        if let Ok(g) = globset::Glob::new(pat) {
            if g.compile_matcher().is_match(path) {
                return true;
            }
        }
    }
    false
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FFFF)
}

fn snippet_of(body: &str, query: &str, max_chars: usize) -> String {
    if !query.is_empty() {
        if let Some(idx) = body.to_lowercase().find(&query.to_lowercase()) {
            let start = idx.saturating_sub(40);
            let end = (idx + query.len() + max_chars).min(body.len());
            let start = floor_char_boundary(body, start);
            let end = floor_char_boundary(body, end);
            return format!("…{}…", &body[start..end]);
        }
    }
    let end = floor_char_boundary(body, max_chars.min(body.len()));
    body[..end].to_string()
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx.min(s.len())
}

/// 规范化 body 用于完全重复检测:
/// - 去首尾空白
/// - 折叠所有连续空白(含中文全角)为单个空格
/// - lowercase
fn normalize_body(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() || ch == '\u{3000}' {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            for c in ch.to_lowercase() {
                out.push(c);
            }
            last_was_space = false;
        }
    }
    out
}

// ─── 时间助手(避免引 chrono)──────────────────────────────────────────────

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn format_rfc3339(secs: u64) -> String {
    let days_since_epoch = (secs / 86400) as i64;
    let s = secs % 86400;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = ymd_from_days(days_since_epoch);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, m, sec)
}

fn ymd_from_days(mut days: i64) -> (i32, u32, u32) {
    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = (days - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

fn parse_rfc3339_secs(s: &str) -> Option<u64> {
    // 极简:期望 "YYYY-MM-DDTHH:MM:SSZ"
    if s.len() < 20 || !s.ends_with('Z') {
        return None;
    }
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let mo: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    let h: u32 = s.get(11..13)?.parse().ok()?;
    let mi: u32 = s.get(14..16)?.parse().ok()?;
    let se: u32 = s.get(17..19)?.parse().ok()?;
    let days = days_from_ymd(y, mo, d)?;
    Some((days as u64) * 86400 + (h * 3600 + mi * 60 + se) as u64)
}

fn days_from_ymd(y: i32, m: u32, d: u32) -> Option<i64> {
    if m < 1 || m > 12 || d < 1 {
        return None;
    }
    let y = if m <= 2 { y as i64 - 1 } else { y as i64 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + (d as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe as i64 - 719468)
}

// ─── 单测 ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn write_for_test_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let id = store
            .write_for_test(
                "test",
                None,
                Scope::Shared,
                "PtyHost::kill 必须用 clone_killer。",
                vec!["pty".into(), "deadlock".into()],
                Some(0.95),
            )
            .unwrap();
        let f = store.read(&id).unwrap();
        assert_eq!(f.meta.id, id);
        assert!(f.body.contains("clone_killer"));
        assert_eq!(f.meta.confidence, 0.95);
        assert!(tmp
            .path()
            .join("vault")
            .join("facts")
            .join(format!("{}.md", id))
            .exists());
    }

    #[test]
    fn search_finds_by_keyword_cn_and_en() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        store
            .write_for_test(
                "a",
                None,
                Scope::Shared,
                "PtyHost kill clone_killer 防死锁",
                vec![],
                None,
            )
            .unwrap();
        store
            .write_for_test(
                "b",
                None,
                Scope::Shared,
                "完全无关的另一条记录",
                vec![],
                None,
            )
            .unwrap();

        let hits = store.search("clone_killer", None, 10, false).unwrap();
        assert!(!hits.is_empty(), "should find by english keyword");

        let hits = store.search("防死锁", None, 10, false).unwrap();
        assert!(
            !hits.is_empty(),
            "should find by cjk keyword (trigram needs >=3 chars)"
        );
    }

    #[test]
    fn propose_writes_to_pending_not_facts() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "新发现:某场景 ABC 必须先做 X 再做 Y",
                vec!["arch".into()],
                None,
                Some(0.9),
                Some("调试 PR #42 时发现".into()),
                false,
                None,
                None,
            )
            .unwrap();
        let id = match r {
            ProposeResult::Accepted { id } => id,
            other => panic!("expected accepted, got {:?}", other),
        };
        // pending 有
        assert!(pending_path(tmp.path(), &id).exists());
        // facts 没
        assert!(!fact_path(tmp.path(), &id, None).exists());
        // search 找不到(未审)
        let hits = store.search("ABC 必须先做 X", None, 10, false).unwrap();
        assert!(!hits.iter().any(|h| h.id == id));
    }

    #[test]
    fn approve_moves_pending_to_facts_and_indexes() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "PtyHost::kill 必须用 clone_killer 拿独立 kill 句柄",
                vec!["pty".into()],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        let id = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        let outcome = store.review(&id, Verdict::Approve).unwrap();
        assert_eq!(outcome, ReviewOutcome::Approved);

        // 文件挪了位置
        assert!(!pending_path(tmp.path(), &id).exists());
        assert!(fact_path(tmp.path(), &id, Some("pty")).exists());

        // 索引建立,可被搜到
        let hits = store.search("clone_killer", None, 10, false).unwrap();
        assert!(hits.iter().any(|h| h.id == id));
    }

    #[test]
    fn propose_without_title_derives_slug_title_from_tags() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let r = store
            .propose(
                "codex",
                None,
                Scope::Project("kode".into()),
                "i18n for kode should use shared message resources",
                vec![
                    "i18n".into(),
                    "gui".into(),
                    "specops".into(),
                    "memory".into(),
                ],
                None,
                None,
                None,
                false,
                Some(Kind::Invariant),
                None,
            )
            .unwrap();
        let id = match r {
            ProposeResult::Accepted { id } => id,
            other => panic!("expected accepted, got {:?}", other),
        };

        let pending = store.read_pending(&id).unwrap();
        assert_eq!(
            pending.meta.title.as_deref(),
            Some("i18n gui specops memory")
        );

        store.review(&id, Verdict::Approve).unwrap();
        assert!(fact_path(tmp.path(), &id, Some("i18n gui specops memory")).exists());

        let hits = store
            .search("shared message resources", None, 10, false)
            .unwrap();
        let hit = hits
            .iter()
            .find(|h| h.id == id)
            .expect("approved fact should be searchable");
        assert_eq!(hit.title.as_deref(), Some("i18n gui specops memory"));

        let short_hits = store.search("gui", None, 10, false).unwrap();
        let short_hit = short_hits
            .iter()
            .find(|h| h.id == id)
            .expect("approved fact should be searchable through short-query fallback");
        assert_eq!(short_hit.title.as_deref(), Some("i18n gui specops memory"));
    }

    #[test]
    fn reject_moves_to_archive_not_indexed() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "我觉得用户喜欢蓝色主题",
                vec!["pref".into()],
                None,
                None,
                Some("agent 主观判断".into()),
                false,
                None,
                None,
            )
            .unwrap();
        let id = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        let outcome = store
            .review(
                &id,
                Verdict::Reject {
                    reason: "用户偏好不归 memory 管".into(),
                },
            )
            .unwrap();
        assert_eq!(outcome, ReviewOutcome::Rejected);
        assert!(tmp
            .path()
            .join(".kode")
            .join("archive")
            .join("rejected")
            .join(format!("{}.md", id))
            .exists());
    }

    #[test]
    fn duplicate_detected_when_proposing_similar() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "PtyHost::kill 必须用 clone_killer 拿独立 kill 句柄",
                vec![],
                None,
            )
            .unwrap();
        // A. 完全相同(只换大小写 / 多空格)→ 必判 dup
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "  PtyHost::kill 必须用  clone_killer 拿独立 kill 句柄  ",
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        match r {
            ProposeResult::Duplicate(info) => {
                assert!(
                    (info.similarity - 1.0).abs() < 1e-3,
                    "exact match should be 1.0"
                );
            }
            other => panic!("expected exact duplicate, got {:?}", other),
        }

        // B. 完全不同的内容应该 accept
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "GUI 用 tauri::ipc::Channel 传字节,不要走 emit",
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        assert!(matches!(r, ProposeResult::Accepted { .. }));
    }

    #[test]
    fn body_too_long_rejected_at_propose() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let body = "x".repeat(MAX_BODY_LEN + 1);
        let r = store
            .propose(
                "agent",
                None,
                Scope::Shared,
                &body,
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        assert!(matches!(r, ProposeResult::BodyTooLong { .. }));
    }

    #[test]
    fn supersedes_marks_old_deprecated_via_approve() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let old = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "用 mutex<child> 同时给 reaper 和 killer",
                vec!["pty".into()],
                None,
            )
            .unwrap();
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "改用 clone_killer 拿独立 kill 句柄",
                vec!["pty".into()],
                Some(old.clone()),
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        let new_id = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        store.review(&new_id, Verdict::Approve).unwrap();
        let hits = store
            .search("mutex OR clone_killer", None, 10, false)
            .unwrap();
        assert!(!hits.iter().any(|h| h.id == old), "old should be filtered");
        let hits2 = store
            .search("mutex OR clone_killer", None, 10, true)
            .unwrap();
        assert!(
            hits2.iter().any(|h| h.id == old),
            "old should appear when including deprecated"
        );
    }

    #[test]
    fn reconcile_rebuilds_index_after_db_loss() {
        let tmp = TempDir::new().unwrap();
        let id;
        {
            let mut store = MemoryStore::open(tmp.path()).unwrap();
            id = store
                .write_for_test(
                    "u",
                    None,
                    Scope::Shared,
                    "唯一关键词 reconciletest",
                    vec![],
                    None,
                )
                .unwrap();
        }
        // 删 SQLite,重新打开应能从 vault/facts/ 重建
        std::fs::remove_file(tmp.path().join(".kode").join("index.sqlite")).unwrap();
        let store = MemoryStore::open(tmp.path()).unwrap();
        let hits = store.search("reconciletest", None, 10, false).unwrap();
        assert!(
            hits.iter().any(|h| h.id == id),
            "reconcile should rebuild index"
        );
    }

    #[test]
    fn list_pending_sorted_by_created() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        for i in 0..3 {
            store
                .propose(
                    "a",
                    None,
                    Scope::Shared,
                    &format!("候选 #{} 待审核", i),
                    vec![],
                    None,
                    None,
                    None,
                    false,
                    None,
                    None,
                )
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1100)); // 跨 1 秒,RFC3339 精度
        }
        let p = store.list_pending().unwrap();
        assert_eq!(p.len(), 3);
        for w in p.windows(2) {
            assert!(w[0].meta.created <= w[1].meta.created);
        }
    }

    #[test]
    fn search_filter_by_kind() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let _gotcha = store
            .write_for_test_full(
                "a",
                None,
                Scope::Shared,
                "PtyHost kill 死锁 gotcha",
                vec![],
                None,
                Kind::Gotcha,
                None,
                vec![],
                vec![],
            )
            .unwrap();
        let dead = store
            .write_for_test_full(
                "a",
                None,
                Scope::Shared,
                "PtyHost kill 用 Mutex<Child> 已知失败",
                vec![],
                None,
                Kind::DeadEnd,
                None,
                vec![],
                vec![],
            )
            .unwrap();

        // 不过滤:两条都召回
        let all = store.search("PtyHost", None, 10, false).unwrap();
        assert_eq!(all.len(), 2);

        // 仅 dead_end:只一条
        let only_dead = store
            .search_filtered(
                "PtyHost",
                10,
                &SearchFilter {
                    kinds: vec![Kind::DeadEnd],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(only_dead.len(), 1);
        assert_eq!(only_dead[0].id, dead);
        assert_eq!(only_dead[0].kind, "dead_end");
    }

    #[test]
    fn propose_respects_kind_arg() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 显式传 invariant
        store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "外层 kode 绝不能进 alt-screen",
                vec![],
                None,
                None,
                None,
                false,
                Some(Kind::Invariant),
                None,
            )
            .unwrap();
        // 不传 kind → 回落 gotcha
        store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "另一条不同的结论防止查重",
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        let pending = store.list_pending().unwrap();
        let inv = pending
            .iter()
            .find(|p| p.meta.kind == Kind::Invariant)
            .expect("invariant fact should exist");
        assert_eq!(inv.meta.kind, Kind::Invariant);
        let got = pending
            .iter()
            .find(|p| p.body.contains("查重"))
            .expect("default-kind fact should exist");
        assert_eq!(got.meta.kind, Kind::Gotcha);
    }

    #[test]
    fn distinct_scopes_dedups_and_sorts() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        for sc in [
            Scope::Project("kode".into()),
            Scope::Project("kode".into()),
            Scope::Shared,
            Scope::Project("aaa".into()),
        ] {
            store
                .write_for_test_full(
                    "a",
                    None,
                    sc,
                    &format!("body {}", ulid::Ulid::new()),
                    vec![],
                    None,
                    Kind::default(),
                    None,
                    vec![],
                    vec![],
                )
                .unwrap();
        }
        let scopes = store.distinct_scopes().unwrap();
        assert_eq!(scopes, vec!["project:aaa", "project:kode", "shared"]);
    }

    #[test]
    fn search_filter_by_subsystem() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let pty_id = store
            .write_for_test_full(
                "a",
                None,
                Scope::Shared,
                "记录 A 关于 deadlock",
                vec![],
                None,
                Kind::default(),
                Some("pty".into()),
                vec![],
                vec![],
            )
            .unwrap();
        let _gui_id = store
            .write_for_test_full(
                "a",
                None,
                Scope::Shared,
                "记录 B 也讲 deadlock",
                vec![],
                None,
                Kind::default(),
                Some("gui".into()),
                vec![],
                vec![],
            )
            .unwrap();

        let pty_only = store
            .search_filtered(
                "deadlock",
                10,
                &SearchFilter {
                    subsystem: Some("pty"),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(pty_only.len(), 1);
        assert_eq!(pty_only[0].id, pty_id);
        assert_eq!(pty_only[0].subsystem.as_deref(), Some("pty"));
    }

    #[test]
    fn legacy_v0_db_alters_in_place() {
        // 模拟 v0 schema 的 SQLite(无 kind / subsystem / applies_to / links 列),
        // open() 应自动 ALTER 加列,write_for_test_full 不报错。
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kode")).unwrap();
        let db = tmp.path().join(".kode").join("index.sqlite");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE facts (
                    id TEXT PRIMARY KEY, author TEXT NOT NULL, session TEXT,
                    scope TEXT NOT NULL, created TEXT NOT NULL, created_ts INTEGER NOT NULL,
                    confidence REAL NOT NULL, tags TEXT NOT NULL, supersedes TEXT,
                    ttl_days INTEGER, deprecated INTEGER NOT NULL DEFAULT 0,
                    body TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE facts_fts USING fts5(id UNINDEXED, body, tags, tokenize='trigram');
                "#,
            ).unwrap();
        }
        // 老 vault 也得在(否则 migrate 不触发,且 open 自己会建 vault)
        std::fs::create_dir_all(tmp.path().join("vault").join("facts")).unwrap();

        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let id = store
            .write_for_test_full(
                "a",
                None,
                Scope::Shared,
                "v0 db 测试",
                vec![],
                None,
                Kind::DeadEnd,
                Some("pty".into()),
                vec![],
                vec![],
            )
            .unwrap();
        let f = store.read(&id).unwrap();
        assert_eq!(f.meta.kind, Kind::DeadEnd);
        assert_eq!(f.meta.subsystem.as_deref(), Some("pty"));
    }

    // ─── Phase 10.10/10.12/10.13 新测试 ─────────────────────────────────────

    #[test]
    fn links_table_written_on_commit_and_backlinks_query() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 先有 A
        let a = store
            .write_for_test("u", None, Scope::Shared, "fact A 主题", vec![], None)
            .unwrap();
        // 再 propose B,带 supersedes=A
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "fact B 替代 A 的内容是不一样的",
                vec![],
                Some(a.clone()),
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        let b = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        store.review(&b, Verdict::Approve).unwrap();

        // A 的反链应包含 B(kind=supersedes)
        let bls = store.backlinks(&a).unwrap();
        // 注意:supersedes 让 A deprecated=1,backlinks() 只列非 deprecated 的 src,所以 B(active)能入
        assert!(
            bls.iter().any(|b| b.kind == "supersedes"),
            "expected supersedes backlink, got {:?}",
            bls
        );
    }

    #[test]
    fn related_and_contradicts_built_via_edit_then_approve() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let a = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "锚点 fact A 不一样的内容",
                vec![],
                None,
            )
            .unwrap();
        let c = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "锚点 fact C 又不一样的内容",
                vec![],
                None,
            )
            .unwrap();

        // 提议 B
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "B 想 link 到 A 与 contradict C 的内容",
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        let b = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        // edit-then-approve 时补 related/contradicts
        store
            .review(
                &b,
                Verdict::EditThenApprove {
                    body: None,
                    tags: None,
                    scope: None,
                    confidence: None,
                    related: Some(vec![a.clone()]),
                    contradicts: Some(vec![c.clone()]),
                    title: None,
                },
            )
            .unwrap();

        // B 的反链:A 应有一条 related 反链(指向 A,src 是 B)
        let a_bls = store.backlinks(&a).unwrap();
        assert!(a_bls.iter().any(|x| x.id == b && x.kind == "related"));
        let c_bls = store.backlinks(&c).unwrap();
        assert!(c_bls.iter().any(|x| x.id == b && x.kind == "contradicts"));
    }

    #[test]
    fn read_with_backlinks_returns_both() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let a = store
            .write_for_test("u", None, Scope::Shared, "fact A 内容", vec![], None)
            .unwrap();
        // 直接 write_for_test_full 一条 related 指向 A
        let _b = store
            .write_for_test_full(
                "u",
                None,
                Scope::Shared,
                "fact B 反链 A",
                vec![],
                None,
                Kind::Gotcha,
                None,
                vec![],
                vec![], // links 字段空
            )
            .unwrap();
        // 手动 approve 一条带 related 的(走 propose+review)
        let r = store
            .propose(
                "u2",
                None,
                Scope::Shared,
                "C 引用 A",
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        let c = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        store
            .review(
                &c,
                Verdict::EditThenApprove {
                    body: None,
                    tags: None,
                    scope: None,
                    confidence: None,
                    related: Some(vec![a.clone()]),
                    contradicts: None,
                    title: None,
                },
            )
            .unwrap();

        let r = store.read_with_backlinks(&a).unwrap();
        assert_eq!(r.fact.meta.id, a);
        assert!(r.backlinks.iter().any(|b| b.id == c && b.kind == "related"));
    }

    #[test]
    fn legacy_links_field_migrates_to_related_on_reconcile() {
        // 直接在 vault 里手写一份带 `links: [01ABC]` 的老 fact,reconcile 后应迁到 related
        let tmp = TempDir::new().unwrap();
        // 先 open 让目录建起来 + 索引初始化(无 fact)
        {
            let _ = MemoryStore::open(tmp.path()).unwrap();
        }
        // 写一个老格式 fact + 一个被引用 fact(避免 reconcile 把它当孤儿删)
        let target_id = "01TARGET00000000000000000";
        let with_links_id = "01OLD00000000000000000000";
        let target_md = format!(
            "---\nid: {}\nauthor: u\nscope: shared\ncreated: 2026-05-01T00:00:00Z\nconfidence: 0.8\ntags: []\ndeprecated: false\n---\nbeing pointed at\n",
            target_id
        );
        let with_links_md = format!(
            "---\nid: {}\nauthor: u\nscope: shared\ncreated: 2026-05-01T00:00:00Z\nconfidence: 0.8\ntags: []\ndeprecated: false\nlinks:\n  - {}\n---\nold fact pointing\n",
            with_links_id, target_id
        );
        std::fs::write(
            tmp.path()
                .join("vault")
                .join("facts")
                .join(format!("{}.md", target_id)),
            target_md,
        )
        .unwrap();
        std::fs::write(
            tmp.path()
                .join("vault")
                .join("facts")
                .join(format!("{}.md", with_links_id)),
            with_links_md,
        )
        .unwrap();

        // 重新 open → 触发 reconcile
        let store = MemoryStore::open(tmp.path()).unwrap();

        // 重新读 fact:related 应包含 target,links 应已清空
        let f = store.read(with_links_id).unwrap();
        assert_eq!(f.meta.related, vec![target_id.to_string()]);
        assert!(
            f.meta.links.is_empty(),
            "legacy links should be cleared after migration"
        );

        // 反链:target 应被 with_links 引用(kind=related)
        let bls = store.backlinks(target_id).unwrap();
        assert!(
            bls.iter()
                .any(|b| b.id == with_links_id && b.kind == "related"),
            "expected related backlink after migration, got {:?}",
            bls
        );
    }

    #[test]
    fn reconcile_idempotent_links_table() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let a = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "fact A 锚点不同内容",
                vec![],
                None,
            )
            .unwrap();
        let _b = {
            let r = store
                .propose(
                    "u",
                    None,
                    Scope::Shared,
                    "fact B 引用 A 的内容是另外一回事",
                    vec![],
                    None,
                    None,
                    None,
                    false,
                    None,
                    None,
                )
                .unwrap();
            let id = match r {
                ProposeResult::Accepted { id } => id,
                _ => panic!(),
            };
            store
                .review(
                    &id,
                    Verdict::EditThenApprove {
                        body: None,
                        tags: None,
                        scope: None,
                        confidence: None,
                        related: Some(vec![a.clone()]),
                        contradicts: None,
                        title: None,
                    },
                )
                .unwrap();
            id
        };

        // 第一次反链
        let before = store.backlinks(&a).unwrap();
        // 跑两次 reconcile
        store.reconcile().unwrap();
        let after1 = store.backlinks(&a).unwrap();
        store.reconcile().unwrap();
        let after2 = store.backlinks(&a).unwrap();
        assert_eq!(before.len(), after1.len());
        assert_eq!(after1.len(), after2.len());
        assert!(after2.iter().any(|x| x.kind == "related"));
    }

    #[test]
    fn glob_path_match_boosts_score() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 同样的 body / confidence / 时间,只 applies_to 不同
        let _matched = store
            .write_for_test_full(
                "u",
                None,
                Scope::Shared,
                "deadlock 在 PtyHost 路径上",
                vec![],
                Some(0.8),
                Kind::Gotcha,
                None,
                vec!["src/pty/**".into()],
                vec![],
            )
            .unwrap();
        let _other = store
            .write_for_test_full(
                "u",
                None,
                Scope::Shared,
                "deadlock 通用条目无路径限制",
                vec![],
                Some(0.8),
                Kind::Gotcha,
                None,
                vec![],
                vec![],
            )
            .unwrap();

        // 不传 current_path:两条分数差异主要由 BM25 决定,排序难预测 — 跳过断言
        // 传 current_path 命中 src/pty/x.rs:matched 应排第一
        let with_path = store
            .search_with_opts(&SearchOpts {
                query: "deadlock",
                top_k: 5,
                current_path: Some("src/pty/host.rs"),
                ..Default::default()
            })
            .unwrap();
        assert!(with_path.len() >= 2);
        // matched 必须比 other 排前(matched 的 path bonus = 1.0,other = 0.0)
        let matched_pos = with_path.iter().position(|h| h.id == _matched).unwrap();
        let other_pos = with_path.iter().position(|h| h.id == _other).unwrap();
        assert!(
            matched_pos < other_pos,
            "path-matched fact should rank higher"
        );
    }

    #[test]
    fn bump_recall_increments_and_reranks() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let a = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "deadlock 通用 A",
                vec![],
                Some(0.8),
            )
            .unwrap();
        let b = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "deadlock 通用 B",
                vec![],
                Some(0.8),
            )
            .unwrap();
        // 没点击的话两条 confidence/recency 一样,只看 BM25
        // 给 b 点 5 次,b 应排在前
        for _ in 0..5 {
            store.bump_recall(&b, Some("deadlock")).unwrap();
        }
        let hits = store.search("deadlock", None, 10, false).unwrap();
        let ap = hits.iter().position(|h| h.id == a).unwrap();
        let bp = hits.iter().position(|h| h.id == b).unwrap();
        assert!(
            bp < ap,
            "b should rank higher after recall_clicked: a={}, b={}",
            ap,
            bp
        );
    }

    #[test]
    fn aggregate_recall_30d_reads_jsonl_into_columns() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let a = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "test fact for aggregate",
                vec![],
                None,
            )
            .unwrap();
        // 模拟 GUI 跨进程写 metrics,然后启动时聚合
        // 直接 bump_recall 多次,然后清空列再 aggregate
        for _ in 0..3 {
            store.bump_recall(&a, None).unwrap();
        }
        // 手动把列清 0(模拟启动时 fresh DB,只有 metrics.jsonl 里有点击记录)
        store
            .conn
            .execute(
                "UPDATE facts SET recall_clicked_count_30d = 0 WHERE id = ?1",
                params![a],
            )
            .unwrap();
        let updated = store.aggregate_recall_30d().unwrap();
        assert!(updated >= 1);
        let count: i64 = store
            .conn
            .query_row(
                "SELECT recall_clicked_count_30d FROM facts WHERE id = ?1",
                params![a],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn short_query_under_3_chars_falls_back_to_like() {
        // 关键回归:trigram tokenizer 不能命中 < 3 字符 query。
        // 用户搜 "ui" 能找到 body 含 "GUI" 或 "ui" 的条目。
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let id_gui = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "GUI 用 tauri::ipc::Channel 传字节,不要走 emit",
                vec![],
                None,
            )
            .unwrap();
        let _id_unrelated = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "完全无关的另一条记录",
                vec![],
                None,
            )
            .unwrap();

        // FTS 直接搜 "ui" 会 0 命中 — 我们的 search 会自动走 LIKE fallback
        let hits = store.search("ui", None, 10, false).unwrap();
        assert!(
            hits.iter().any(|h| h.id == id_gui),
            "short query 'ui' should match 'GUI' substring via LIKE fallback, got {:?}",
            hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn short_query_respects_filters() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 两条都有 "ui" 子串,只有一条是 dead_end
        let _gotcha = store
            .write_for_test_full(
                "u",
                None,
                Scope::Shared,
                "GUI gotcha 路径",
                vec![],
                None,
                Kind::Gotcha,
                None,
                vec![],
                vec![],
            )
            .unwrap();
        let dead = store
            .write_for_test_full(
                "u",
                None,
                Scope::Shared,
                "GUI 用 prompt 弹框失败的方案",
                vec![],
                None,
                Kind::DeadEnd,
                None,
                vec![],
                vec![],
            )
            .unwrap();

        // 短 query "ui" + kind=dead_end → 仅一条
        let hits = store
            .search_with_opts(&SearchOpts {
                query: "ui",
                top_k: 10,
                kinds: vec![Kind::DeadEnd],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, dead);
    }

    #[test]
    fn short_query_with_sql_wildcards_treated_as_literal() {
        // 用户搜 "%" 不应匹配所有 — 我们 LIKE ESCAPE 把它当字面量
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let plain = store
            .write_for_test("u", None, Scope::Shared, "无百分号的内容 abc", vec![], None)
            .unwrap();
        let with_pct = store
            .write_for_test(
                "u",
                None,
                Scope::Shared,
                "含百分号 50% off 的内容",
                vec![],
                None,
            )
            .unwrap();
        let hits = store.search("%", None, 10, false).unwrap();
        // 含 "%" 的必须命中
        assert!(
            hits.iter().any(|h| h.id == with_pct),
            "literal % should match fact containing the % character"
        );
        // 不含的不应被命中(若 ESCAPE 失效,LIKE '%%%' 会匹配所有 → plain 也会出现)
        assert!(
            !hits.iter().any(|h| h.id == plain),
            "% should be a literal, not a wildcard — plain fact should NOT match"
        );
    }

    // ─── 2026-06 重复检测改造回归 ──────────────────────────────────────────

    /// 阈值锁定:DUP_THRESHOLD 抬到 0.75。
    /// 锁住常量,防止后续被无意改回低值。
    #[test]
    fn dup_threshold_is_at_least_zero_seven_five() {
        // 直接断言常量,改它必须改这里 — 强制讨论
        assert!(
            DUP_THRESHOLD >= 0.75 - 1e-6,
            "DUP_THRESHOLD lowered below 0.75; previous value 0.5 caused false-positive dup rejections \
             on short rule-like text. Re-justify in PR before lowering."
        );
    }

    /// 真实场景回归:两条「项目规范类」短文本,语义完全不同,只共享高频结构性词
    /// (i18n 双语同步 / clang 配置同步)。0.5 阈值时被误判为 duplicate(用户实测 0.52),
    /// 0.75 阈值后两条都应被接受。
    #[test]
    fn rule_like_short_facts_no_longer_misflagged_as_duplicate() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 已有的 i18n 规则
        store
            .write_for_test(
                "user",
                None,
                Scope::Shared,
                "apps/mobile (Flutter) 任何新增/修改的 UI 文案都必须走 AppLocalizations + intl_zh.arb / intl_en.arb 双语同步,禁止硬编码中文或英文。",
                vec!["i18n".into(), "flutter".into()],
                None,
            )
            .unwrap();

        // 新提:完全不同语义,但都含「禁止 / 必须 / 同步」类结构词
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "客户端 C++ 项目必须通过 palm-device-sync-rules 同步 .clang-format / .clang-tidy,禁止本地手改。",
                vec!["clang".into(), "cxx".into()],
                None,
                None,
                None,
                false,
                None,
                None,            )
            .unwrap();

        match r {
            ProposeResult::Accepted { .. } => {}
            ProposeResult::Duplicate(info) => panic!(
                "expected acceptance — short rule-like facts of different topics should not collide. \
                 similarity={} top_id={} candidates={}",
                info.similarity,
                info.existing_id,
                info.candidates.len()
            ),
            other => panic!("unexpected: {:?}", other),
        }
    }

    /// `force=true` 跳过近似查重,但**不**跳过完全相同(A 路径)。
    #[test]
    fn force_skips_fts_dup_but_not_exact_dup() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 种子一条
        store
            .write_for_test(
                "user",
                None,
                Scope::Shared,
                "PtyHost::kill 必须用 clone_killer 拿独立 kill 句柄",
                vec![],
                None,
            )
            .unwrap();

        // 完全相同 + force=true → 仍被拦(A 路径)
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "PtyHost::kill 必须用 clone_killer 拿独立 kill 句柄",
                vec![],
                None,
                None,
                None,
                true, // force,
                None,
                None,
            )
            .unwrap();
        assert!(
            matches!(r, ProposeResult::Duplicate(info) if (info.similarity - 1.0).abs() < 1e-3),
            "force MUST NOT bypass exact-duplicate detection"
        );
    }

    /// FTS 近似查重(B 路径):不带 force → Duplicate;force=true → Accepted。
    /// body 不完全相同(规避 A 路径),但共享足够词汇命中 DUP_THRESHOLD。
    #[test]
    fn force_true_skips_fts_near_dup_and_accepts() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        // 先塞一批不相关 decoy,让 facts_fts 里文档数 > 1 ——
        // bm25 的 IDF 项才有意义:目标 token 越稀有,命中时 bm25 越负 → bm25_norm→1。
        for i in 0..20 {
            store
                .write_for_test(
                    "user",
                    None,
                    Scope::Shared,
                    &format!("无关噪声文档 alpha{i} beta{i} 随便写点别的内容填充语料库"),
                    vec![],
                    Some(0.5),
                )
                .unwrap();
        }

        // 种子一条:含一个在语料里独一无二的稀有 token,confidence 拉满抬高总分。
        let seed_body = "zqxwvk clonekiller 这条规则讲 PtyHost kill 必须用独立句柄 zqxwvk";
        store
            .write_for_test("user", None, Scope::Shared, seed_body, vec![], Some(1.0))
            .unwrap();

        // 近似(非完全相同):共享稀有 token → 规避 A 路径(规范化 body 不等),
        // 但稀有 token 的 trigram 命中 → bm25 强负 → FTS 分数稳过 DUP_THRESHOLD。
        let near = "zqxwvk clonekiller 这条规则讲 PtyHost kill 必须用独立句柄 zqxwvk 见模块文档";

        // 不带 force → 判 Duplicate(B 路径)
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                near,
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        assert!(
            matches!(r, ProposeResult::Duplicate(_)),
            "FTS near-duplicate should be flagged without force, got {:?}",
            r
        );

        // 带 force=true → 跳过 B,Accepted
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                near,
                vec![],
                None,
                None,
                None,
                true, // force,
                None,
                None,
            )
            .unwrap();
        assert!(
            matches!(r, ProposeResult::Accepted { .. }),
            "force=true must skip FTS near-dup and accept, got {:?}",
            r
        );
    }

    /// duplicate 返回 `candidates` 数组(top-K),让 agent 自己挑:
    /// supersedes / force / 放弃。
    /// 这里制造一条注定能命中 FTS 阈值的近似 fact(完全一致 body)→ candidates 至少 1 条
    #[test]
    fn duplicate_info_returns_candidates_array() {
        let tmp = TempDir::new().unwrap();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let _existing = store
            .write_for_test(
                "user",
                None,
                Scope::Shared,
                "foo bar 必须用 X",
                vec![],
                None,
            )
            .unwrap();

        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "foo bar 必须用 X", // 完全相同 → A 路径
                vec![],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();

        match r {
            ProposeResult::Duplicate(info) => {
                assert!(
                    !info.candidates.is_empty(),
                    "candidates must contain at least the existing top match"
                );
                assert_eq!(info.candidates[0].id, info.existing_id);
            }
            other => panic!("expected Duplicate, got {:?}", other),
        }
    }
}
