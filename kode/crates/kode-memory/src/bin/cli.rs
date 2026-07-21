//! kode-memory CLI:让用户/agent 不开 GUI 就能玩 memory 系统。
//!
//! 子命令:
//!   init                        初始化目录,可选 --with-baseline 灌种子
//!   propose <body>              提议一条 fact 进 pending
//!   pending [--limit N]         列待审
//!   review <id> --verdict X     审核
//!   search <query>              检索已审核 facts
//!   recent [--hours N]          看最近写入
//!   read <id>                   看一条完整 fact
//!   deprecate <id> --reason     标 deprecated
//!   budget [author]             看能量
//!   dashboard                   总览
//!
//! 路径默认 ~/.kode-memory,可用 --root 或 env KODE_MEMORY_ROOT 覆盖。

use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use clap::{Parser, Subcommand, ValueEnum};
use kode_memory::{
    budget::{
        BudgetError, BudgetStore, COST_PROPOSE, MAX_ENERGY, PENALTY_BLACKLIST, PENALTY_REJECT,
        REWARD_APPROVE,
    },
    git_sync::{self, SyncOpts},
    store::{ProposeResult, ReviewOutcome, Verdict},
    Kind, MemoryStore, Scope,
};
use std::path::PathBuf;

/// 嵌入到 binary 里的 baseline seeds(`init --with-baseline` 用)
const BASELINE_SEEDS: &str = include_str!("../../tests/baseline/seeds.jsonl");

#[derive(Parser)]
#[command(
    name = "kode-memory",
    version,
    about = "Shared memory pool for AI agents"
)]
struct Cli {
    /// memory 根目录(默认 ~/.kode-memory,或 env KODE_MEMORY_ROOT)
    #[arg(long, global = true)]
    root: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 初始化 memory 目录;--with-baseline 灌入 50+ 种子 fact 用于体验
    Init {
        #[arg(long)]
        with_baseline: bool,
    },
    /// 提议一条新 fact(进 pending,等审核)
    Propose {
        /// fact 正文(必填,可用 - 从 stdin 读)
        body: String,
        #[arg(long, default_value = "user")]
        author: String,
        #[arg(long, default_value = "shared")]
        scope: String,
        /// 逗号分隔
        #[arg(long, default_value = "")]
        tags: String,
        #[arg(long)]
        confidence: Option<f32>,
        #[arg(long)]
        supersedes: Option<String>,
        #[arg(long)]
        rationale: Option<String>,
        #[arg(long)]
        session: Option<String>,
        /// 跳过 FTS 近似查重(完全相同仍会拦)。仅在确认 candidates 是不同语义时使用
        #[arg(long, default_value_t = false)]
        force: bool,
        /// fact 种类:gotcha / invariant / recipe / dead_end / preference(默认 gotcha)
        #[arg(long)]
        kind: Option<String>,
    },
    /// 列待审提议
    Pending {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// 输出 JSON 而非彩色文本(供脚本/Go server 解析)
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 审核一条 pending
    Review {
        id: String,
        #[arg(long)]
        verdict: VerdictArg,
        #[arg(long, default_value = "")]
        reason: String,
        #[arg(long)]
        edited_body: Option<String>,
        #[arg(long)]
        edited_scope: Option<String>,
        /// 逗号分隔
        #[arg(long)]
        edited_tags: Option<String>,
        #[arg(long)]
        edited_confidence: Option<f32>,
        /// 输出 JSON 而非彩色文本(供脚本/Go server 解析)
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 关键词搜索 facts
    Search {
        query: String,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long, default_value_t = 5)]
        top_k: usize,
        /// 输出 JSON 而非彩色文本(供脚本/Go server 解析)
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 看一条完整 fact
    Read { id: String },
    /// 列最近 N 小时新增 facts
    Recent {
        #[arg(long, default_value_t = 24)]
        hours: u64,
        #[arg(long)]
        scope: Option<String>,
    },
    /// 标记 fact deprecated
    Deprecate {
        id: String,
        #[arg(long)]
        reason: String,
    },
    /// 查看能量预算
    Budget {
        /// 不指定时列出所有 author
        author: Option<String>,
    },
    /// 总览
    Dashboard,
    /// git 同步:vault/(facts/+pending/)的跨机同步
    Sync {
        /// 初始化:git init + 写 .gitattributes/.gitignore + add remote + 写 sync.json
        #[arg(long)]
        init: bool,
        /// git remote url(init 时必填)
        #[arg(long)]
        remote: Option<String>,
        /// 分支名(默认 main)
        #[arg(long)]
        branch: Option<String>,
        /// 本次只 pull 不 push
        #[arg(long)]
        no_push: bool,
        /// 启用 auto_sync
        #[arg(long, conflicts_with = "disable")]
        enable: bool,
        /// 禁用 auto_sync
        #[arg(long, conflicts_with = "enable")]
        disable: bool,
    },
    /// Codex command hook entrypoint. Intended to be called by ~/.codex/hooks.json.
    CodexHook,
    /// CodeBuddy/Claude command hook bridge. Rewrites session_id → KODE_SESSION_ID
    /// and relays to KODE_HOOK_SOCK. Called by ~/.codebuddy|.claude/settings.json hooks.
    CodebuddyHook,
}

#[derive(Clone, Copy, ValueEnum, PartialEq, Eq)]
enum VerdictArg {
    Approve,
    EditThenApprove,
    Reject,
    Blacklist,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = resolve_root(cli.root)?;

    match cli.cmd {
        Cmd::Init { with_baseline } => cmd_init(&root, with_baseline),
        Cmd::Propose {
            body,
            author,
            scope,
            tags,
            confidence,
            supersedes,
            rationale,
            session,
            force,
            kind,
        } => {
            let body = if body == "-" { read_stdin()? } else { body };
            cmd_propose(
                &root,
                &author,
                session.as_deref(),
                &scope,
                &body,
                &tags,
                supersedes,
                confidence,
                rationale,
                force,
                kind.as_deref(),
            )
        }
        Cmd::Pending { limit, json } => cmd_pending(&root, limit, json),
        Cmd::Review {
            id,
            verdict,
            reason,
            edited_body,
            edited_scope,
            edited_tags,
            edited_confidence,
            json,
        } => cmd_review(
            &root,
            &id,
            verdict,
            &reason,
            edited_body,
            edited_scope,
            edited_tags,
            edited_confidence,
            json,
        ),
        Cmd::Search {
            query,
            scope,
            top_k,
            json,
        } => cmd_search(&root, &query, scope.as_deref(), top_k, json),
        Cmd::Read { id } => cmd_read(&root, &id),
        Cmd::Recent { hours, scope } => cmd_recent(&root, hours, scope.as_deref()),
        Cmd::Deprecate { id, reason } => cmd_deprecate(&root, &id, &reason),
        Cmd::Budget { author } => cmd_budget(&root, author.as_deref()),
        Cmd::Dashboard => cmd_dashboard(&root),
        Cmd::Sync {
            init,
            remote,
            branch,
            no_push,
            enable,
            disable,
        } => cmd_sync(&root, init, remote, branch, no_push, enable, disable),
        Cmd::CodexHook => kode_memory::codex_hook::run(),
        Cmd::CodebuddyHook => kode_memory::codebuddy_hook::run(),
    }
}

fn resolve_root(arg: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = arg {
        return Ok(p);
    }
    if let Ok(v) = std::env::var("KODE_MEMORY_ROOT") {
        return Ok(PathBuf::from(v));
    }
    Ok(dirs::home_dir()
        .context("no home dir")?
        .join(".kode-memory"))
}

/// budget.json 当前在 `<root>/.kode/budget.json`(2026-06+)。
/// 兼容老布局 `<root>/budget.json`:`BudgetStore::open` 已经在迁移,
/// 但用户没跑过 open 时直接读 dashboard,这里回退一下。
fn budget_json_path(root: &std::path::Path) -> std::path::PathBuf {
    let new_path = root.join(".kode").join("budget.json");
    if new_path.exists() {
        return new_path;
    }
    let old_path = root.join("budget.json");
    if old_path.exists() {
        return old_path;
    }
    new_path
}

fn read_stdin() -> Result<String> {
    use std::io::Read;
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s)?;
    Ok(s.trim().to_string())
}

// ─── 子命令实现 ───────────────────────────────────────────────────────

fn cmd_init(root: &std::path::Path, with_baseline: bool) -> Result<()> {
    let existed = root.exists();
    let mut store = MemoryStore::open(root)?;
    let _ = BudgetStore::open(root)?;

    if existed {
        println!("{}存量目录:{}", c_dim(), root.display());
        println!(
            "{}已有 facts:{} | pending:{}{}",
            c_dim(),
            store.count()?,
            store.count_pending()?,
            c_reset()
        );
    } else {
        println!("{}✓ 初始化:{}{}", c_green(), root.display(), c_reset());
    }

    if with_baseline {
        let mut added = 0;
        for line in BASELINE_SEEDS.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            #[derive(serde::Deserialize)]
            struct Seed {
                #[allow(dead_code)]
                id: String,
                scope: String,
                body: String,
                #[serde(default)]
                tags: Vec<String>,
            }
            let s: Seed = serde_json::from_str(line)?;
            // baseline 灌入跳过 dedup —— seeds 之间互相相似是正常的,我们要全部
            let scope = Scope::parse(&s.scope)?;
            store.write_for_test("baseline", None, scope, &s.body, s.tags, None)?;
            added += 1;
        }
        println!("{}✓ baseline seeds:added={}{}", c_green(), added, c_reset());
    }

    println!();
    println!("下一步:");
    println!(
        "  {} kode-memory dashboard{}     # 看总览",
        c_cyan(),
        c_reset()
    );
    println!(
        "  {} kode-memory search 'PTY'{}  # 搜一搜",
        c_cyan(),
        c_reset()
    );
    println!(
        "  {} kode-memory propose 'xxx'{} # 提议(进 pending)",
        c_cyan(),
        c_reset()
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_propose(
    root: &std::path::Path,
    author: &str,
    session: Option<&str>,
    scope_str: &str,
    body: &str,
    tags_csv: &str,
    supersedes: Option<String>,
    confidence: Option<f32>,
    rationale: Option<String>,
    force: bool,
    kind_str: Option<&str>,
) -> Result<()> {
    let mut store = MemoryStore::open(root)?;
    let mut budget = BudgetStore::open(root)?;
    let scope = Scope::parse(scope_str)?;
    let kind = kind_str.map(Kind::parse).transpose()?;
    let tags: Vec<String> = tags_csv
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // 扣能量
    let remaining = match budget.try_charge(author, COST_PROPOSE) {
        Ok(r) => r,
        Err(BudgetError::OutOfEnergy {
            current,
            needed,
            next_refill_at,
        }) => {
            eprintln!(
                "{}✗ 能量不足{}:当前 {:.2},需要 {:.2}。下次回血到 1 点 ≈ unix {}",
                c_red(),
                c_reset(),
                current,
                needed,
                next_refill_at
            );
            std::process::exit(2);
        }
        Err(e) => return Err(anyhow::anyhow!("{}", e)),
    };

    let r = store.propose(
        author, session, scope, body, tags, supersedes, confidence, rationale, force, kind, None,
    )?;
    match r {
        ProposeResult::Accepted { id } => {
            println!(
                "{}✓ pending{} id={} energy={:.2}/{}",
                c_green(),
                c_reset(),
                id,
                remaining,
                MAX_ENERGY
            );
            println!("  审核:kode-memory review {} --verdict approve", id);
        }
        ProposeResult::Duplicate(info) => {
            // 退还
            let _ = budget.add(author, COST_PROPOSE);
            println!(
                "{}⚠ duplicate{}:相似度 {:.2},已有 id={}",
                c_yellow(),
                c_reset(),
                info.similarity,
                info.existing_id
            );
            println!("  老 fact 摘要:{}", info.snippet);
            if info.candidates.len() > 1 {
                println!("  其他相似候选:");
                for c in info.candidates.iter().skip(1) {
                    println!("    [{:.2}] {} {}", c.similarity, c.id, c.snippet);
                }
            }
            println!("  ⇒ 是同一规则换种说法 → 跳过");
            println!("  ⇒ 老 fact 该被替换 → --supersedes {}", info.existing_id);
            println!("  ⇒ 候选都是不同规则只是词汇撞车 → --force");
        }
        ProposeResult::BodyTooLong { len, max } => {
            let _ = budget.add(author, COST_PROPOSE);
            println!(
                "{}✗ body 超长{}:{} 字符,最大 {}。请拆成多条小 fact",
                c_red(),
                c_reset(),
                len,
                max
            );
        }
    }
    Ok(())
}

fn cmd_pending(root: &std::path::Path, limit: usize, json: bool) -> Result<()> {
    let store = MemoryStore::open(root)?;
    let pending = store.list_pending()?;

    if json {
        let mut budget = BudgetStore::open(root).ok();
        let mut dtos: Vec<PendingDto> = Vec::new();
        for p in pending.iter().take(limit) {
            let author_energy = budget
                .as_mut()
                .map(|b| b.current_energy(&p.meta.author))
                .unwrap_or(0.0);
            dtos.push(PendingDto {
                id: p.meta.id.clone(),
                author: p.meta.author.clone(),
                session: p.meta.session.clone(),
                scope: p.meta.scope.clone(),
                created: p.meta.created.clone(),
                confidence: p.meta.confidence,
                tags: p.meta.tags.clone(),
                kind: p.meta.kind.as_str().to_string(),
                subsystem: p.meta.subsystem.clone(),
                supersedes: p.meta.supersedes.clone(),
                body: p.body.clone(),
                rationale: p.rationale.clone(),
                author_energy,
            });
        }
        let wrapper = PendingJson { pending: dtos };
        println!("{}", serde_json::to_string(&wrapper)?);
        return Ok(());
    }

    if pending.is_empty() {
        println!("{}(无待审){}", c_dim(), c_reset());
        return Ok(());
    }
    println!("{}{} 条待审{}", c_bold(), pending.len(), c_reset());
    for (i, p) in pending.iter().take(limit).enumerate() {
        println!();
        println!(
            "{}#{}{} {} {} [{}] tags={:?}",
            c_cyan(),
            i + 1,
            c_reset(),
            p.meta.id,
            c_dim_text(&local_time(&p.meta.created)),
            p.meta.author,
            p.meta.tags
        );
        println!(
            "  scope: {}  confidence: {:.2}",
            p.meta.scope, p.meta.confidence
        );
        println!("  body : {}", first_line_clip(&p.body, 200));
        if let Some(r) = &p.rationale {
            println!(
                "  why  : {}{}{}",
                c_dim(),
                first_line_clip(r, 200),
                c_reset()
            );
        }
    }
    if pending.len() > limit {
        println!(
            "{}... 还有 {} 条未显示(用 --limit 调){}",
            c_dim(),
            pending.len() - limit,
            c_reset()
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_review(
    root: &std::path::Path,
    id: &str,
    verdict: VerdictArg,
    reason: &str,
    edited_body: Option<String>,
    edited_scope: Option<String>,
    edited_tags: Option<String>,
    edited_confidence: Option<f32>,
    json: bool,
) -> Result<()> {
    let mut store = MemoryStore::open(root)?;
    let mut budget = BudgetStore::open(root)?;
    let pending = store.read_pending(id)?;
    let author = pending.meta.author.clone();

    let v = match verdict {
        VerdictArg::Approve => Verdict::Approve,
        VerdictArg::EditThenApprove => Verdict::EditThenApprove {
            body: edited_body,
            tags: edited_tags.map(|s| {
                s.split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect()
            }),
            scope: edited_scope.map(|s| Scope::parse(&s)).transpose()?,
            confidence: edited_confidence,
            related: None,
            contradicts: None,
            title: None,
        },
        VerdictArg::Reject => Verdict::Reject {
            reason: if reason.is_empty() {
                "(no reason)".into()
            } else {
                reason.into()
            },
        },
        VerdictArg::Blacklist => Verdict::Blacklist {
            reason: if reason.is_empty() {
                "(no reason)".into()
            } else {
                reason.into()
            },
        },
    };
    let outcome = store.review(id, v)?;
    let outcome_str;
    match outcome {
        ReviewOutcome::Approved => {
            let _ = budget.add(&author, REWARD_APPROVE);
            outcome_str = "approved";
            if !json {
                println!(
                    "{}✓ approved{} → facts/  energy({})={:.2}",
                    c_green(),
                    c_reset(),
                    author,
                    budget.current_energy(&author)
                );
            }
            // best-effort git sync(失败不致命)
            if git_sync::is_enabled(root) {
                let msg = format!("kode-memory: approve {}", id);
                match git_sync::commit_and_push(root, &msg) {
                    Ok(true) if !json => println!("{}  ✓ git synced{}", c_dim(), c_reset()),
                    Ok(true) => {} // json 模式不打印
                    Ok(false) => {}
                    Err(e) => eprintln!("{}  ⚠ git sync failed: {}{}", c_yellow(), e, c_reset()),
                }
            }
        }
        ReviewOutcome::Rejected => {
            let _ = budget.penalize(&author, PENALTY_REJECT);
            outcome_str = "rejected";
            if !json {
                println!(
                    "{}✗ rejected{} → archive/  energy({})={:.2}",
                    c_yellow(),
                    c_reset(),
                    author,
                    budget.current_energy(&author)
                );
            }
        }
        ReviewOutcome::Blacklisted => {
            let _ = budget.penalize(&author, PENALTY_BLACKLIST);
            outcome_str = "blacklisted";
            if !json {
                println!(
                    "{}🚫 blacklisted{} → archive/  energy({})={:.2}",
                    c_red(),
                    c_reset(),
                    author,
                    budget.current_energy(&author)
                );
            }
        }
    }

    if json {
        let dto = ReviewJson {
            outcome: outcome_str.to_string(),
            author_energy: budget.current_energy(&author),
            id: id.to_string(),
        };
        println!("{}", serde_json::to_string(&dto)?);
    }

    Ok(())
}

fn cmd_search(
    root: &std::path::Path,
    query: &str,
    scope: Option<&str>,
    top_k: usize,
    json: bool,
) -> Result<()> {
    let store = MemoryStore::open(root)?;
    let hits = store.search(query, scope, top_k, false)?;

    if json {
        let dtos: Vec<SearchHitDto> = hits
            .iter()
            .map(|h| SearchHitDto {
                id: h.id.clone(),
                author: h.author.clone(),
                scope: h.scope.clone(),
                kind: h.kind.clone(),
                subsystem: h.subsystem.clone(),
                created: h.created.clone(),
                confidence: h.confidence,
                tags: h.tags.clone(),
                title: h.title.clone(),
                snippet: h.snippet.clone(),
                score: h.score,
            })
            .collect();
        let wrapper = SearchJson { hits: dtos };
        println!("{}", serde_json::to_string(&wrapper)?);
        return Ok(());
    }

    if hits.is_empty() {
        println!("{}(无命中){}", c_dim(), c_reset());
        return Ok(());
    }
    println!("{}{} 条命中{}", c_bold(), hits.len(), c_reset());
    for (i, h) in hits.iter().enumerate() {
        println!();
        println!(
            "{}#{}{} {} {} score={:.3} [{}]",
            c_cyan(),
            i + 1,
            c_reset(),
            h.id,
            c_dim_text(&local_time(&h.created)),
            h.score,
            h.author
        );
        println!(
            "  scope: {}  conf: {:.2}  tags: {:?}",
            h.scope, h.confidence, h.tags
        );
        println!("  {}", h.snippet);
    }
    Ok(())
}

fn cmd_read(root: &std::path::Path, id: &str) -> Result<()> {
    let store = MemoryStore::open(root)?;
    let f = store.read(id)?;
    println!("id        : {}", f.meta.id);
    println!("author    : {}", f.meta.author);
    println!("scope     : {}", f.meta.scope);
    println!("created   : {}", local_time(&f.meta.created));
    println!("confidence: {:.2}", f.meta.confidence);
    println!("tags      : {:?}", f.meta.tags);
    if let Some(s) = &f.meta.supersedes {
        println!("supersedes: {}", s);
    }
    if f.meta.deprecated {
        println!("{}deprecated: yes{}", c_yellow(), c_reset());
    }
    println!();
    println!("{}", f.body);
    Ok(())
}

fn cmd_recent(root: &std::path::Path, hours: u64, scope: Option<&str>) -> Result<()> {
    let store = MemoryStore::open(root)?;
    let hits = store.list_recent(scope, hours)?;
    if hits.is_empty() {
        println!("{}(最近 {}h 无新增){}", c_dim(), hours, c_reset());
        return Ok(());
    }
    println!(
        "{}最近 {}h 新增 {} 条{}",
        c_bold(),
        hours,
        hits.len(),
        c_reset()
    );
    for h in hits {
        println!(
            "  {} {} [{}] {}",
            c_dim_text(&local_time(&h.created)),
            h.id,
            h.author,
            first_line_clip(&h.snippet, 100)
        );
    }
    Ok(())
}

fn cmd_deprecate(root: &std::path::Path, id: &str, reason: &str) -> Result<()> {
    let mut store = MemoryStore::open(root)?;
    store.deprecate(id, reason)?;
    println!("{}✓ deprecated{} {}", c_green(), c_reset(), id);
    Ok(())
}

fn cmd_budget(root: &std::path::Path, author: Option<&str>) -> Result<()> {
    let mut budget = BudgetStore::open(root)?;
    if let Some(a) = author {
        let e = budget.current_energy(a);
        println!(
            "{}: {:.2} / {:.0}  ({})",
            a,
            e,
            MAX_ENERGY,
            energy_bar(e, MAX_ENERGY)
        );
    } else {
        // 列所有(读 .kode/budget.json,兼容老 budget.json)
        let path = budget_json_path(root);
        if !path.exists() {
            println!("{}(无 author 记录){}", c_dim(), c_reset());
            return Ok(());
        }
        let text = std::fs::read_to_string(&path)?;
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let authors = v.get("authors").and_then(|v| v.as_object());
        if let Some(authors) = authors {
            if authors.is_empty() {
                println!("{}(无 author 记录){}", c_dim(), c_reset());
                return Ok(());
            }
            println!("{}{:<20} energy{}", c_bold(), "author", c_reset());
            let mut names: Vec<&str> = authors.keys().map(|s| s.as_str()).collect();
            names.sort();
            for name in names {
                let e = budget.current_energy(name);
                println!(
                    "  {:<20} {:.2}/{:.0}  {}",
                    name,
                    e,
                    MAX_ENERGY,
                    energy_bar(e, MAX_ENERGY)
                );
            }
        }
    }
    Ok(())
}

fn cmd_dashboard(root: &std::path::Path) -> Result<()> {
    let store = MemoryStore::open(root)?;
    let mut budget = BudgetStore::open(root)?;
    let n_facts = store.count()?;
    let n_pending = store.count_pending()?;
    let archive_path = root.join(".kode").join("archive").join("rejected");
    let n_rejected = if archive_path.exists() {
        std::fs::read_dir(&archive_path)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
            .count()
    } else {
        0
    };

    println!(
        "{}╭─ kode-memory dashboard ─────────────────────╮{}",
        c_bold(),
        c_reset()
    );
    println!("│  root       : {}", root.display());
    println!("│  facts      : {}", n_facts);
    println!("│  pending    : {}", n_pending);
    println!("│  rejected   : {}", n_rejected);
    println!("│");

    // top author by energy
    let path = budget_json_path(root);
    if path.exists() {
        let text = std::fs::read_to_string(&path)?;
        let v: serde_json::Value = serde_json::from_str(&text)?;
        if let Some(authors) = v.get("authors").and_then(|v| v.as_object()) {
            if !authors.is_empty() {
                println!("│  energy:");
                let mut names: Vec<&str> = authors.keys().map(|s| s.as_str()).collect();
                names.sort();
                for name in names {
                    let e = budget.current_energy(name);
                    println!(
                        "│    {:<16} {:.2}/{:.0}  {}",
                        name,
                        e,
                        MAX_ENERGY,
                        energy_bar(e, MAX_ENERGY)
                    );
                }
            }
        }
    }

    if n_pending > 0 {
        println!("│");
        println!(
            "│  {}⚠ {} 条待审{} → kode-memory pending",
            c_yellow(),
            n_pending,
            c_reset()
        );
    }

    // M5 metrics:7 天接受率 + by-author
    if let Ok(agg) = store.metrics().aggregate_7d() {
        println!("│");
        match agg.accept_rate {
            Some(r) => println!(
                "│  7d accept rate : {:.0}% (reviews={})",
                r * 100.0,
                agg.totals
            ),
            None => println!("│  7d accept rate : -- (无审核事件)"),
        }
        if !agg.by_author_accept_rate.is_empty() {
            let mut authors: Vec<&String> = agg.by_author_accept_rate.keys().collect();
            authors.sort();
            for a in authors {
                let s = &agg.by_author_accept_rate[a];
                let pct = match s.rate {
                    Some(r) => format!("{:.0}%", r * 100.0),
                    None => "--".to_string(),
                };
                println!("│    {:<16} {} ({}/{})", a, pct, s.accepts, s.total_reviews);
            }
        }
    }

    println!(
        "{}╰─────────────────────────────────────────────╯{}",
        c_bold(),
        c_reset()
    );
    Ok(())
}

fn cmd_sync(
    root: &std::path::Path,
    init: bool,
    remote: Option<String>,
    branch: Option<String>,
    no_push: bool,
    enable: bool,
    disable: bool,
) -> Result<()> {
    if enable || disable {
        let mut cfg = git_sync::load_config(root)?;
        cfg.auto_sync = enable;
        git_sync::save_config(root, &cfg)?;
        println!("{}auto_sync = {}{}", c_green(), cfg.auto_sync, c_reset());
        return Ok(());
    }

    if init {
        let remote = remote.context("--init 需要 --remote <url>")?;
        let branch = branch.unwrap_or_else(|| "main".into());
        git_sync::init_repo(root, &remote, &branch)?;
        println!(
            "{}✓ git repo initialized{}:{} branch={} remote={}",
            c_green(),
            c_reset(),
            root.join("vault").display(),
            branch,
            remote,
        );
        println!("  auto_sync = true, auto_push = true");
        return Ok(());
    }

    // 默认:manual sync(忽略 auto_sync,首次会自动 init)
    let mut store = MemoryStore::open(root)?;
    let report = git_sync::sync_once(
        &mut store,
        root,
        &SyncOpts {
            do_pull: true,
            do_push: !no_push,
            message: None,
        },
        None,
    )?;

    if let Some(reason) = &report.skipped_reason {
        println!("{}(skipped: {}){}", c_dim(), reason, c_reset());
        return Ok(());
    }

    println!("{}sync report{}", c_bold(), c_reset());
    println!(
        "  initialized : {}",
        if report.initialized {
            format!("{}yes{}", c_green(), c_reset())
        } else {
            "no".into()
        }
    );
    println!(
        "  pulled : {}",
        if report.pulled {
            format!(
                "{}yes{}+{} reconciled",
                c_green(),
                c_reset(),
                report.reconciled
            )
        } else {
            "no change".into()
        }
    );
    println!(
        "  pushed : {}",
        if report.pushed {
            format!("{}yes{}", c_green(), c_reset())
        } else {
            "no".into()
        }
    );
    Ok(())
}

// ─── JSON DTO ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct PendingJson {
    pending: Vec<PendingDto>,
}

#[derive(serde::Serialize)]
struct PendingDto {
    id: String,
    author: String,
    session: Option<String>,
    scope: String,
    created: String,
    confidence: f32,
    tags: Vec<String>,
    kind: String,
    subsystem: Option<String>,
    supersedes: Option<String>,
    body: String,
    rationale: Option<String>,
    author_energy: f32,
}

#[derive(serde::Serialize)]
struct SearchJson {
    hits: Vec<SearchHitDto>,
}

#[derive(serde::Serialize)]
struct SearchHitDto {
    id: String,
    author: String,
    scope: String,
    kind: String,
    subsystem: Option<String>,
    created: String,
    confidence: f32,
    tags: Vec<String>,
    title: Option<String>,
    snippet: String,
    score: f32,
}

#[derive(serde::Serialize)]
struct ReviewJson {
    outcome: String,
    author_energy: f32,
    id: String,
}

// ─── helpers ──────────────────────────────────────────────────────────

fn first_line_clip(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("");
    if line.chars().count() > max {
        let mut idx = 0;
        let mut taken = 0;
        for (i, _) in line.char_indices() {
            if taken >= max {
                idx = i;
                break;
            }
            taken += 1;
        }
        format!("{}…", &line[..idx])
    } else {
        line.to_string()
    }
}

fn energy_bar(e: f32, max: f32) -> String {
    let segs = 10;
    let filled = ((e / max) * segs as f32).round().clamp(0.0, segs as f32) as usize;
    let empty = segs - filled;
    let color = if e >= 3.5 {
        c_green()
    } else if e >= 1.5 {
        c_yellow()
    } else {
        c_red()
    };
    format!(
        "{}{}{}{}{}",
        color,
        "█".repeat(filled),
        c_dim(),
        "░".repeat(empty),
        c_reset()
    )
}

fn local_time(s: &str) -> String {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| {
            dt.with_timezone(&Local)
                .format("%Y-%m-%d %H:%M:%S %Z")
                .to_string()
        })
        .unwrap_or_else(|_| s.to_string())
}

fn c_reset() -> &'static str {
    if use_color() {
        "\x1b[0m"
    } else {
        ""
    }
}
fn c_bold() -> &'static str {
    if use_color() {
        "\x1b[1m"
    } else {
        ""
    }
}
fn c_dim() -> &'static str {
    if use_color() {
        "\x1b[2m"
    } else {
        ""
    }
}
fn c_red() -> &'static str {
    if use_color() {
        "\x1b[31m"
    } else {
        ""
    }
}
fn c_green() -> &'static str {
    if use_color() {
        "\x1b[32m"
    } else {
        ""
    }
}
fn c_yellow() -> &'static str {
    if use_color() {
        "\x1b[33m"
    } else {
        ""
    }
}
fn c_cyan() -> &'static str {
    if use_color() {
        "\x1b[36m"
    } else {
        ""
    }
}
fn c_dim_text(s: &str) -> String {
    format!("{}{}{}", c_dim(), s, c_reset())
}
fn use_color() -> bool {
    // 简单:tty 时上色,管道时不上色
    std::env::var("NO_COLOR").is_err() && atty()
}
fn atty() -> bool {
    // 标准库无 isatty,退化为 stdout fd 是否是 tty 用 unsafe libc
    // 没必要引依赖,粗暴判断:CI 或 NO_COLOR 时不上色
    std::env::var("CI").is_err() && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
}
