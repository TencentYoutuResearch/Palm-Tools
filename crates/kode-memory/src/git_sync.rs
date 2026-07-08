//! git 同步:vault/(facts/ + pending/)的去中心化跨机/remote 同步。
//!
//! 设计原则(改前先读 .specops/specs/memory-git-sync.md):
//! 1. **外部 git CLI**:std::process::Command 调系统 git,不引入 git2
//! 2. **best-effort**:push 失败/git 没装/remote 没配 → 降级 warn,绝不阻塞核心 memory 操作
//! 3. **union merge**:靠 ULID 文件粒度天然无冲突;.gitattributes 配 merge=union 兜底
//! 4. **pull 后必 reconcile**:sync() 是唯一暴露给外部的编排函数,固化这条链
//! 5. **agent 不能 push**:本模块不进 MCP 工具列表,仅 CLI + GUI 后台调用
//! 6. **store 不依赖 git**:store.rs 零改动;本模块单向依赖 store(仅调 reconcile)

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Output;

use crate::store::{private_dir, vault_dir};

// ─── SyncConfig ───────────────────────────────────────────────────────

const SYNC_CONFIG_FILENAME: &str = "sync.json";
const DEFAULT_BRANCH: &str = "main";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    /// git remote url。None = 未初始化,commit_and_push 只本地 commit 不 push。
    pub remote: Option<String>,

    /// 默认 main。
    #[serde(default = "default_branch")]
    pub branch: String,

    /// 总开关。false 时 is_enabled 返回 false,所有同步操作跳过。
    #[serde(default)]
    pub auto_sync: bool,

    /// approve 后是否自动 push。关掉只本地 commit。
    #[serde(default)]
    pub auto_push: bool,
}

fn default_branch() -> String {
    DEFAULT_BRANCH.into()
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            remote: None,
            branch: default_branch(),
            auto_sync: false,
            auto_push: false,
        }
    }
}

fn sync_config_path(root: &Path) -> PathBuf {
    private_dir(root).join(SYNC_CONFIG_FILENAME)
}

/// sync.json 是否存在。GUI 用这个做“首次使用/需要初始化”判断。
pub fn has_sync_config(root: &Path) -> bool {
    sync_config_path(root).exists()
}

pub fn load_config(root: &Path) -> Result<SyncConfig> {
    let path = sync_config_path(root);
    let mut cfg = if !path.exists() {
        SyncConfig::default()
    } else {
        let text =
            std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?
    };
    // 如果 sync.json 里没配 remote，从 vault/.git/config 里读 origin url
    if cfg.remote.is_none() {
        cfg.remote = read_git_remote(root);
    }
    Ok(cfg)
}

pub fn save_config(root: &Path, cfg: &SyncConfig) -> Result<()> {
    let path = sync_config_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))
}

// ─── SyncReport ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SyncReport {
    pub pulled: bool,
    pub pushed: bool,
    pub reconciled: usize,
    pub initialized: bool,
    pub skipped_reason: Option<String>,
}

impl SyncReport {
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self {
            pulled: false,
            pushed: false,
            reconciled: 0,
            initialized: false,
            skipped_reason: Some(reason.into()),
        }
    }
}

// ─── SyncOpts ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct SyncOpts {
    pub do_pull: bool,
    pub do_push: bool,
    pub message: Option<String>,
}

// ─── git CLI 封装 ─────────────────────────────────────────────────────

/// 跑 `git <args>`，工作目录 = vault_dir(root)。
/// 非 0 退出码 → anyhow error 拼上 stderr。
fn git(root: &Path, args: &[&str]) -> Result<Output> {
    let out = std::process::Command::new("git")
        .current_dir(vault_dir(root))
        .args(args)
        .output()
        .with_context(|| format!("git {} (dir={})", args.join(" "), vault_dir(root).display()))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("git {}: {}", args.join(" "), stderr.trim());
    }
    Ok(out)
}

/// 同 git() 但不检查退出码 —— 返回 false 时调用方自行判断。
fn git_ok(root: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .current_dir(vault_dir(root))
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn push_origin(root: &Path, branch: &str) -> Result<()> {
    git(root, &["push", "origin", branch]).map(|_| ())
}

/// 检查 vault/ 是否已 git init。
pub fn is_git_repo(root: &Path) -> bool {
    vault_dir(root).join(".git").exists()
}

/// 从 vault/.git/config 里读 [remote "origin"] 的 url。
/// 允许用户直接 `cd vault && git remote add origin <url>` 而不用写 sync.json。
fn read_git_remote(root: &Path) -> Option<String> {
    let git_config = vault_dir(root).join(".git").join("config");
    let text = std::fs::read_to_string(&git_config).ok()?;
    let mut in_origin = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == "[remote \"origin\"]" {
            in_origin = true;
            continue;
        }
        if in_origin {
            if trimmed.starts_with('[') {
                break; // next section
            }
            if let Some(url) = trimmed.strip_prefix("url = ") {
                return Some(url.trim().to_string());
            }
        }
    }
    None
}

/// git --version 探测。ENOENT(命令不存在)→ 返回带平台安装引导的 error。
pub fn ensure_git_available() -> Result<()> {
    match std::process::Command::new("git").arg("--version").output() {
        Ok(out) if out.status.success() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!(
                "git 未安装。安装方法:\n\
                 macOS:   brew install git   (或 xcode-select --install)\n\
                 Linux:   sudo apt install git  /  sudo yum install git\n\
                 其他:    https://git-scm.com/downloads"
            );
        }
        Err(e) => Err(anyhow::anyhow!("git --version 失败: {}", e)),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            anyhow::bail!("git --version 异常退出: {}", stderr.trim());
        }
    }
}

/// sync.json 存在且 auto_sync = true。
pub fn is_enabled(root: &Path) -> bool {
    load_config(root).map(|c| c.auto_sync).unwrap_or(false)
}

// ─── init_repo ────────────────────────────────────────────────────────

/// 在 vault/ 下 git init + 写 .gitattributes/.gitignore + add remote + 写 sync.json。
/// 若 vault/ 已是 git repo,跳过 init 步骤(幂等)。
pub fn init_repo(root: &Path, remote: &str, branch: &str) -> Result<()> {
    ensure_git_available()?;

    let vault = vault_dir(root);
    std::fs::create_dir_all(&vault)?;

    // 幂等:已是 git repo 就跳过 git init
    if !is_git_repo(root) {
        git(root, &["init", "-b", branch])?;
    }

    // .gitattributes
    let ga = vault.join(".gitattributes");
    let attr_content = "facts/*.md merge=union\npending/*.md merge=union\n";
    let needs_ga = !ga.exists() || std::fs::read_to_string(&ga).unwrap_or_default() != attr_content;
    if needs_ga {
        std::fs::write(&ga, attr_content)?;
    }

    // .gitignore
    let gi = vault.join(".gitignore");
    let gi_content = "# Obsidian 配置是用户私有的,不同步\n.obsidian/\n";
    let needs_gi = !gi.exists() || std::fs::read_to_string(&gi).unwrap_or_default() != gi_content;
    if needs_gi {
        std::fs::write(&gi, gi_content)?;
    }

    // 初始 commit(若无)
    if !git_ok(root, &["rev-parse", "HEAD"]) {
        // 确保目录存在,避免 git add 因路径不存在而失败
        let _ = std::fs::create_dir_all(vault.join("facts"));
        let _ = std::fs::create_dir_all(vault.join("pending"));
        // 先 stage .gitattributes + .gitignore
        let _ = git(root, &["add", ".gitattributes", ".gitignore"]);
        // 也 stage 已有文件(如果有)
        let _ = git(root, &["add", "facts/", "pending/"]);
        // commit
        let _ = git(root, &["commit", "-m", "kode-memory: init vault repo"]);
    }

    // remote
    let existing_remote = git(root, &["remote", "get-url", "origin"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .ok();
    if existing_remote.as_deref() != Some(remote) {
        // 先删再设,幂等
        let _ = git(root, &["remote", "remove", "origin"]);
        git(root, &["remote", "add", "origin", remote])?;
    }

    // 写配置
    let cfg = SyncConfig {
        remote: Some(remote.to_string()),
        branch: branch.to_string(),
        auto_sync: true,
        auto_push: true,
    };
    save_config(root, &cfg)?;

    Ok(())
}

/// 自动初始化:git init + .gitattributes/.gitignore + sync.json(auto_sync=true,auto_push=true)。
/// 与 `init_repo` 的区别:不设 remote。auto_push=true 但 remote=None,实际 push 会跳过。
/// 一旦用户配了 remote(通过 sync.json 或 git remote add),下次 approve 就会自动 push。
pub fn auto_init(root: &Path) -> Result<()> {
    let vault = vault_dir(root);
    std::fs::create_dir_all(&vault)?;

    if !is_git_repo(root) {
        git(root, &["init", "-b", DEFAULT_BRANCH])?;
    }

    // .gitattributes
    let ga = vault.join(".gitattributes");
    let attr_content = "facts/*.md merge=union\npending/*.md merge=union\n";
    if !ga.exists() || std::fs::read_to_string(&ga).unwrap_or_default() != attr_content {
        std::fs::write(&ga, attr_content)?;
    }

    // .gitignore
    let gi = vault.join(".gitignore");
    let gi_content = "# Obsidian 配置是用户私有的,不同步\n.obsidian/\n";
    if !gi.exists() || std::fs::read_to_string(&gi).unwrap_or_default() != gi_content {
        std::fs::write(&gi, gi_content)?;
    }

    // 写默认配置(本地提交;auto_push=true 但 remote=None,实际 push 会跳过)
    let cfg = SyncConfig {
        remote: None,
        branch: DEFAULT_BRANCH.into(),
        auto_sync: true,
        auto_push: true,
    };
    save_config(root, &cfg)?;

    // 初始 commit(仅框架文件,不 commit 已有的 facts/,让 commit_and_push 后续流程处理)
    if !git_ok(root, &["rev-parse", "HEAD"]) {
        let _ = std::fs::create_dir_all(vault.join("facts"));
        let _ = std::fs::create_dir_all(vault.join("pending"));
        let _ = git(root, &["add", ".gitattributes", ".gitignore"]);
        let _ = git(root, &["commit", "-m", "kode-memory: auto-init vault repo"]);
    }

    Ok(())
}

// ─── commit_and_push ──────────────────────────────────────────────────

/// git add facts/ pending/ → commit → (auto_push 时 push)。
/// 无变更返回 Ok(false)。**best-effort**:push 失败已 commit 成功,仅打 warn,不返回 Err。
///
/// 如果 vault/ 还不是 git repo,**自动** git init + 写 .gitattributes/.gitignore
/// + 创建默认 sync.json(auto_sync=true, auto_push=true, remote=None)。
/// 这样用户无需手动执行 `kode-memory sync --init`,approve 时自动就有本地 git 历史。
pub fn commit_and_push(root: &Path, message: &str) -> Result<bool> {
    commit_and_push_internal(root, message, false)
}

fn commit_and_push_internal(root: &Path, message: &str, force_push: bool) -> Result<bool> {
    if !is_enabled(root) {
        // auto_sync=false → 跳过。但如果连 sync.json 都没有(首次使用),
        // 自动创建默认配置并初始化 git repo。
        let cfg_path = sync_config_path(root);
        if !cfg_path.exists() {
            if ensure_git_available().is_err() {
                return Ok(false);
            }
            auto_init(root)?;
            // 自动初始化后 auto_sync=true,继续走后面的 commit 流程
        } else if !force_push {
            return Ok(false);
        }
    }
    if ensure_git_available().is_err() {
        return Ok(false);
    }
    if !is_git_repo(root) {
        return Ok(false);
    }

    let cfg = load_config(root)?;

    // 检查有无变更
    let status = match git(root, &["status", "--porcelain", "facts/", "pending/"]) {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return Ok(false),
    };
    if status.is_empty() {
        return Ok(false);
    }

    // add + commit:确保目录存在,避免 pending/ 不存在时 git add 整体失败
    let _ = std::fs::create_dir_all(vault_dir(root).join("facts"));
    let _ = std::fs::create_dir_all(vault_dir(root).join("pending"));
    let _ = git(root, &["add", "facts/", "pending/"]);
    if git(root, &["commit", "-m", message]).is_err() {
        // 可能没有变更(所有文件已 tracked 且没改)
        return Ok(false);
    }

    // push(best-effort):先 pull 避免 non-fast-forward
    if (force_push || cfg.auto_push) && cfg.remote.is_some() {
        // pull_union 失败不阻塞 push(可能 remote 还没内容,或者网络不通)
        let _ = pull_union(root);
        match push_origin(root, &cfg.branch) {
            Ok(_) => {}
            Err(e) => {
                eprintln!(
                    "[kode-memory] git push 失败(网络或 remote 问题,已本地 commit):{}",
                    e
                );
            }
        }
    }

    Ok(true)
}

// ─── pull_union ───────────────────────────────────────────────────────

/// git fetch → merge -X union。返回是否有更新(HEAD 变了)。
pub fn pull_union(root: &Path) -> Result<bool> {
    if !is_git_repo(root) {
        return Ok(false);
    }
    if ensure_git_available().is_err() {
        return Ok(false);
    }

    let cfg = load_config(root)?;
    if cfg.remote.is_none() {
        return Ok(false);
    }

    let before = match git(root, &["rev-parse", "HEAD"]) {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return Ok(false),
    };

    // fetch
    if git(root, &["fetch", "origin"]).is_err() {
        return Ok(false);
    }

    // merge:union 合并由 .gitattributes 的 `facts/*.md merge=union` 驱动(逐文件并集),
    // **不是** `-X union` —— `-X` 只接受 ours/theirs/patience 等,`union` 不是合法 strategy
    // option(旧实现传 `-X union` 在 git ≥ 某版本直接 `fatal: unknown strategy option`,
    // 导致 merge 静默失败、pull_union 永远返回 false)。
    // --no-edit:union merge 产生 merge commit 时不弹 editor。
    // --allow-unrelated-histories:处理独立 init 的 repo 首次拉取。
    let _ = git(
        root,
        &[
            "merge",
            "--no-edit",
            "--allow-unrelated-histories",
            &format!("origin/{}", cfg.branch),
        ],
    );

    let after = match git(root, &["rev-parse", "HEAD"]) {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return Ok(false),
    };

    Ok(before != after)
}

// ─── sync ─────────────────────────────────────────────────────────────

/// 顶层编排:ensure_git → pull_union → 若有更新 reconcile → 返回 SyncReport。
/// 这是唯一依赖 MemoryStore 的公共函数。
pub fn sync(store: &mut crate::MemoryStore, root: &Path, opts: &SyncOpts) -> Result<SyncReport> {
    sync_inner(store, root, opts, false, None)
}

/// 手动 sync:忽略 auto_sync 开关;首次无 sync.json 时会自动 init。
pub fn sync_once(
    store: &mut crate::MemoryStore,
    root: &Path,
    opts: &SyncOpts,
    remote_override: Option<&str>,
) -> Result<SyncReport> {
    sync_inner(store, root, opts, true, remote_override)
}

fn sync_inner(
    store: &mut crate::MemoryStore,
    root: &Path,
    opts: &SyncOpts,
    force: bool,
    remote_override: Option<&str>,
) -> Result<SyncReport> {
    let cfg_path = sync_config_path(root);
    let mut initialized = false;
    let remote_override = remote_override.map(str::trim).filter(|s| !s.is_empty());
    let existing_cfg = if cfg_path.exists() {
        Some(load_config(root)?)
    } else {
        None
    };

    if let Err(e) = ensure_git_available() {
        return Ok(SyncReport::skipped(format!("git unavailable: {}", e)));
    }

    if let Some(remote) = remote_override {
        let current_remote = existing_cfg.as_ref().and_then(|cfg| cfg.remote.as_deref());
        let need_init = !cfg_path.exists() || !is_git_repo(root) || current_remote != Some(remote);
        if need_init {
            let branch = existing_cfg
                .as_ref()
                .map(|cfg| cfg.branch.clone())
                .unwrap_or_else(|| DEFAULT_BRANCH.into());
            let preserve_flags = existing_cfg
                .as_ref()
                .map(|cfg| (cfg.auto_sync, cfg.auto_push));
            init_repo(root, remote, &branch)?;
            if let Some((auto_sync, auto_push)) = preserve_flags {
                let mut cfg = load_config(root)?;
                cfg.auto_sync = auto_sync;
                cfg.auto_push = auto_push;
                save_config(root, &cfg)?;
            }
            initialized = true;
        }
    } else if !cfg_path.exists() {
        auto_init(root)?;
        initialized = true;
    } else if !force && !is_enabled(root) {
        return Ok(SyncReport::skipped("auto_sync disabled"));
    }

    if !is_git_repo(root) {
        return Ok(SyncReport::skipped(
            "not a git repo (run kode-memory sync --init --remote <url>)",
        ));
    }

    let mut pulled = false;
    let mut reconciled = 0usize;

    if opts.do_pull {
        pulled = pull_union(root)?;
        if pulled {
            reconciled = store.reconcile()?;
        }
    }

    let mut pushed = false;
    if opts.do_push {
        let msg = opts
            .message
            .clone()
            .unwrap_or_else(|| "kode-memory: auto sync".into());
        pushed = commit_and_push_internal(root, &msg, force)?;
        if !pushed && initialized {
            if let Ok(cfg) = load_config(root) {
                if cfg.remote.is_some() && push_origin(root, &cfg.branch).is_ok() {
                    pushed = true;
                }
            }
        }
    }

    Ok(SyncReport {
        pulled,
        pushed,
        reconciled,
        initialized,
        skipped_reason: None,
    })
}

// ─── tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryStore;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// 全局锁:git bare repo 操作在并发测试下有竞态(两个 test 同时 git init --bare
    /// + git push 到独立 temp dir 也可能冲突)。这把锁把涉及 bare repo 的测试串行化。
    static BARE_REPO_LOCK: Mutex<()> = Mutex::new(());

    fn init_test_root() -> TempDir {
        let tmp = TempDir::new().unwrap();
        // 确保 vault/ 目录存在,store 打开时会创建
        std::fs::create_dir_all(vault_dir(tmp.path())).unwrap();
        tmp
    }

    fn has_git() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // ── SyncConfig ──

    #[test]
    fn config_roundtrip() {
        let tmp = init_test_root();
        let cfg = SyncConfig {
            remote: Some("git@github.com:me/memory.git".into()),
            branch: "dev".into(),
            auto_sync: true,
            auto_push: false,
        };
        save_config(tmp.path(), &cfg).unwrap();
        let loaded = load_config(tmp.path()).unwrap();
        assert_eq!(
            loaded.remote.as_deref(),
            Some("git@github.com:me/memory.git")
        );
        assert_eq!(loaded.branch, "dev");
        assert!(loaded.auto_sync);
        assert!(!loaded.auto_push);
    }

    #[test]
    fn config_missing_returns_default() {
        let tmp = init_test_root();
        let cfg = load_config(tmp.path()).unwrap();
        assert!(cfg.remote.is_none());
        assert_eq!(cfg.branch, DEFAULT_BRANCH);
        assert!(!cfg.auto_sync);
        assert!(!cfg.auto_push);
    }

    #[test]
    fn config_not_in_vault() {
        let tmp = init_test_root();
        let cfg = SyncConfig {
            remote: Some("git@example.com:test.git".into()),
            branch: DEFAULT_BRANCH.into(),
            auto_sync: true,
            auto_push: true,
        };
        save_config(tmp.path(), &cfg).unwrap();
        // .kode/sync.json 不应在 vault/ 下(不会被 git 追踪)
        assert!(!vault_dir(tmp.path()).join(".kode").exists());
        assert!(!vault_dir(tmp.path()).join("sync.json").exists());
    }

    // ── ensure_git_available ──

    #[test]
    fn ensure_git_works_when_git_installed() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        ensure_git_available().unwrap();
    }

    // ── init_repo ──

    #[test]
    fn init_repo_creates_git_and_config() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();

        // .git 存在
        assert!(vault_dir(tmp.path()).join(".git").exists());

        // .gitattributes 含 union
        let ga = std::fs::read_to_string(vault_dir(tmp.path()).join(".gitattributes")).unwrap();
        assert!(ga.contains("facts/*.md merge=union"));
        assert!(ga.contains("pending/*.md merge=union"));

        // remote
        let remote = git(tmp.path(), &["remote", "get-url", "origin"]).unwrap();
        let remote_str = String::from_utf8_lossy(&remote.stdout);
        assert!(remote_str.contains("git@example.com:test/memory.git"));

        // config
        let cfg = load_config(tmp.path()).unwrap();
        assert_eq!(
            cfg.remote.as_deref(),
            Some("git@example.com:test/memory.git")
        );
        assert!(cfg.auto_sync);
        assert!(cfg.auto_push);
    }

    #[test]
    fn init_repo_idempotent() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        // 两次 init 不应报错
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();

        assert!(vault_dir(tmp.path()).join(".git").exists());
    }

    // ── commit_and_push ──

    #[test]
    fn commit_no_changes_returns_false() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();
        // 没有新文件 → 不应 commit
        let pushed = commit_and_push(tmp.path(), "test commit").unwrap();
        assert!(!pushed);
    }

    #[test]
    fn commit_with_changes_returns_true() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();

        // 写一条 fact 文件
        let fact_path = vault_dir(tmp.path())
            .join("facts")
            .join("01JX00000000000000000001.md");
        std::fs::create_dir_all(fact_path.parent().unwrap()).unwrap();
        std::fs::write(&fact_path, "---\nid: 01JX00000000000000000001\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\ntest fact").unwrap();

        // auto_push=false,remote 设为不存在 —— commit 成功但 push 会降级
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some("git@example.com:test/memory.git".into()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: true,
                auto_push: false,
            },
        )
        .unwrap();

        let pushed = commit_and_push(tmp.path(), "test: add fact").unwrap();
        assert!(pushed);

        // 验证有 commit
        let log = git(tmp.path(), &["log", "--oneline"]).unwrap();
        let log_str = String::from_utf8_lossy(&log.stdout);
        assert!(log_str.contains("test: add fact"));
    }

    #[test]
    fn commit_disabled_when_auto_sync_false() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some("git@example.com:test/memory.git".into()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: false,
                auto_push: true,
            },
        )
        .unwrap();

        // 即使有变更,auto_sync=false 也应跳过
        let fact_path = vault_dir(tmp.path())
            .join("facts")
            .join("01JX00000000000000000002.md");
        std::fs::create_dir_all(fact_path.parent().unwrap()).unwrap();
        std::fs::write(&fact_path, "---\nid: 01JX00000000000000000002\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\ntest fact").unwrap();

        let pushed = commit_and_push(tmp.path(), "should not commit").unwrap();
        assert!(!pushed);
    }

    #[test]
    fn commit_handles_no_remote() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        // init 但不设 remote(直接写空配置)
        git(tmp.path(), &["init"]).unwrap();
        let _ = git(tmp.path(), &["add", ".gitattributes"]);
        let _ = git(tmp.path(), &["add", ".gitignore"]);
        let _ = git(tmp.path(), &["commit", "--allow-empty", "-m", "init"]);
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: None,
                branch: DEFAULT_BRANCH.into(),
                auto_sync: true,
                auto_push: true,
            },
        )
        .unwrap();

        // 有变更 → 本地 commit,不 push
        let fact_path = vault_dir(tmp.path())
            .join("facts")
            .join("01JX00000000000000000003.md");
        std::fs::create_dir_all(fact_path.parent().unwrap()).unwrap();
        std::fs::write(&fact_path, "---\nid: 01JX00000000000000000003\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\ntest fact").unwrap();

        let pushed = commit_and_push(tmp.path(), "local only").unwrap();
        assert!(pushed); // commit 成功了
    }

    // ── pull_union + reconcile ──

    #[test]
    fn pull_union_two_clones_union_merge() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let _lock = BARE_REPO_LOCK.lock().unwrap();
        let bare = TempDir::new().unwrap();
        // bare repo 作为"中心"
        std::process::Command::new("git")
            .args(["init", "--bare", "-b", DEFAULT_BRANCH])
            .current_dir(bare.path())
            .output()
            .unwrap();

        let bare_path = format!("file://{}", bare.path().display());

        // clone A → 写 facts/a.md → push
        let tmp_a = init_test_root();
        init_repo(tmp_a.path(), &bare_path, DEFAULT_BRANCH).unwrap();
        let facts_a = vault_dir(tmp_a.path()).join("facts");
        std::fs::create_dir_all(&facts_a).unwrap();
        std::fs::write(
            facts_a.join("01JX0000000000000000000A.md"),
            "---\nid: 01JX0000000000000000000A\nauthor: a\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nfact A",
        ).unwrap();
        let _ = git(tmp_a.path(), &["add", "facts/"]);
        let _ = git(tmp_a.path(), &["commit", "-m", "A"]);
        let _ = git(tmp_a.path(), &["push", "origin", DEFAULT_BRANCH]);

        // clone B → 写 facts/b.md → push(先 pull A 的内容)
        let tmp_b = init_test_root();
        init_repo(tmp_b.path(), &bare_path, DEFAULT_BRANCH).unwrap();
        // B 需要先拉 A 的初始 commit,否则 push 会 non-fast-forward
        let _ = pull_union(tmp_b.path());
        let facts_b = vault_dir(tmp_b.path()).join("facts");
        std::fs::create_dir_all(&facts_b).unwrap();
        std::fs::write(
            facts_b.join("01JX0000000000000000000B.md"),
            "---\nid: 01JX0000000000000000000B\nauthor: b\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nfact B",
        ).unwrap();
        let _ = git(tmp_b.path(), &["add", "facts/"]);
        let _ = git(tmp_b.path(), &["commit", "-m", "B"]);
        let _ = git(tmp_b.path(), &["push", "origin", DEFAULT_BRANCH]);

        // A pull → 拿到 B 的文件 → reconcile
        let pulled = pull_union(tmp_a.path()).unwrap();
        assert!(pulled, "A should have pulled B's commit");

        // reconcile 后索引含两条(MemoryStore::open 已自动 reconcile)
        let mut store = MemoryStore::open(tmp_a.path()).unwrap();
        let count = store.count().unwrap();
        assert!(count >= 2, "should have both facts indexed, got {}", count);
    }

    #[test]
    fn sync_pull_triggers_reconcile() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let _lock = BARE_REPO_LOCK.lock().unwrap();
        let bare = TempDir::new().unwrap();
        std::process::Command::new("git")
            .args(["init", "--bare", "-b", DEFAULT_BRANCH])
            .current_dir(bare.path())
            .output()
            .unwrap();
        let bare_path = format!("file://{}", bare.path().display());

        // 一台机 create+push
        let tmp_a = init_test_root();
        init_repo(tmp_a.path(), &bare_path, DEFAULT_BRANCH).unwrap();
        let facts_a = vault_dir(tmp_a.path()).join("facts");
        std::fs::create_dir_all(&facts_a).unwrap();
        std::fs::write(
            facts_a.join("01JXSYNC000000000000000001.md"),
            "---\nid: 01JXSYNC000000000000000001\nauthor: sync\nscope: project:sync\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nsync fact",
        ).unwrap();
        let _ = git(tmp_a.path(), &["add", "facts/"]);
        let _ = git(tmp_a.path(), &["commit", "-m", "seed"]);
        let _ = git(tmp_a.path(), &["push", "origin", DEFAULT_BRANCH]);

        // 另一台机:先 open store,再手动把 pull 来的文件写入 facts/ 模拟 git pull 的效果
        let tmp_b = init_test_root();
        let mut store_b = MemoryStore::open(tmp_b.path()).unwrap();
        // init_repo 后 vault/ 已 git init + 设了 remote
        init_repo(tmp_b.path(), &bare_path, DEFAULT_BRANCH).unwrap();

        // sync do_pull——pull_union 会从 bare fetch 到 A 的提交并 merge
        let report = sync(
            &mut store_b,
            tmp_b.path(),
            &SyncOpts {
                do_pull: true,
                do_push: false,
                message: None,
            },
        )
        .unwrap();
        assert!(report.pulled, "should have pulled new commits");
        assert!(
            report.reconciled >= 1,
            "reconcile should have indexed the pulled fact, got {}",
            report.reconciled
        );
    }

    // ── 降级路径 ──

    #[test]
    fn is_enabled_false_when_no_config() {
        let tmp = init_test_root();
        assert!(!is_enabled(tmp.path()));
    }

    #[test]
    fn is_enabled_respects_auto_sync() {
        let tmp = init_test_root();
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some("git@example.com:test.git".into()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: false,
                auto_push: true,
            },
        )
        .unwrap();
        assert!(!is_enabled(tmp.path()));

        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some("git@example.com:test.git".into()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: true,
                auto_push: false,
            },
        )
        .unwrap();
        assert!(is_enabled(tmp.path()));
    }

    #[test]
    fn sync_skips_when_disabled() {
        let tmp = init_test_root();
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some("git@example.com:test.git".into()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: false,
                auto_push: true,
            },
        )
        .unwrap();

        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let report = sync(
            &mut store,
            tmp.path(),
            &SyncOpts {
                do_pull: true,
                do_push: false,
                message: None,
            },
        )
        .unwrap();
        assert!(report.skipped_reason.is_some());
        assert!(!report.pulled);
        assert!(!report.pushed);
    }

    #[test]
    fn sync_once_ignores_auto_sync_disabled() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        init_repo(
            tmp.path(),
            "git@example.com:test/memory.git",
            DEFAULT_BRANCH,
        )
        .unwrap();
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some("git@example.com:test/memory.git".into()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: false,
                auto_push: true,
            },
        )
        .unwrap();

        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let report = sync_once(
            &mut store,
            tmp.path(),
            &SyncOpts {
                do_pull: true,
                do_push: false,
                message: None,
            },
            None,
        )
        .unwrap();

        assert!(report.skipped_reason.is_none());
        assert!(!report.initialized);
    }

    #[test]
    fn sync_auto_initializes_when_no_config() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let report = sync(
            &mut store,
            tmp.path(),
            &SyncOpts {
                do_pull: true,
                do_push: false,
                message: None,
            },
        )
        .unwrap();

        assert!(report.initialized, "first sync should auto-init repo");
        assert!(report.skipped_reason.is_none());
        assert!(is_git_repo(tmp.path()));
        assert!(vault_dir(tmp.path()).join(".gitattributes").exists());
        assert!(vault_dir(tmp.path()).join(".gitignore").exists());
        let cfg = load_config(tmp.path()).unwrap();
        assert!(cfg.auto_sync);
        assert!(cfg.auto_push);
    }

    #[test]
    fn sync_once_with_remote_override_initializes_and_pushes() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let _lock = BARE_REPO_LOCK.lock().unwrap();
        let bare = TempDir::new().unwrap();
        std::process::Command::new("git")
            .args(["init", "--bare", "-b", DEFAULT_BRANCH])
            .current_dir(bare.path())
            .output()
            .unwrap();
        let remote = format!("file://{}", bare.path().display());

        let tmp = init_test_root();
        let fact_path = vault_dir(tmp.path())
            .join("facts")
            .join("01JXREMOTE0000000000000001.md");
        std::fs::create_dir_all(fact_path.parent().unwrap()).unwrap();
        std::fs::write(
            &fact_path,
            "---\nid: 01JXREMOTE0000000000000001\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nremote sync fact",
        )
        .unwrap();

        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let report = sync_once(
            &mut store,
            tmp.path(),
            &SyncOpts {
                do_pull: true,
                do_push: true,
                message: Some("manual sync".into()),
            },
            Some(&remote),
        )
        .unwrap();

        assert!(report.initialized, "first sync should initialize the repo");
        assert!(report.pushed, "manual sync should push to remote");
        let cfg = load_config(tmp.path()).unwrap();
        assert_eq!(cfg.remote.as_deref(), Some(remote.as_str()));

        let remote_head = std::process::Command::new("git")
            .args([
                "--git-dir",
                bare.path().to_str().unwrap(),
                "rev-parse",
                "refs/heads/main",
            ])
            .output()
            .unwrap();
        assert!(
            remote_head.status.success(),
            "remote branch should exist after push"
        );
    }

    #[test]
    fn sync_once_force_pushes_when_auto_push_disabled() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let _lock = BARE_REPO_LOCK.lock().unwrap();
        let bare = TempDir::new().unwrap();
        std::process::Command::new("git")
            .args(["init", "--bare", "-b", DEFAULT_BRANCH])
            .current_dir(bare.path())
            .output()
            .unwrap();
        let remote = format!("file://{}", bare.path().display());

        let tmp = init_test_root();
        init_repo(tmp.path(), &remote, DEFAULT_BRANCH).unwrap();
        save_config(
            tmp.path(),
            &SyncConfig {
                remote: Some(remote.clone()),
                branch: DEFAULT_BRANCH.into(),
                auto_sync: false,
                auto_push: false,
            },
        )
        .unwrap();

        let fact_path = vault_dir(tmp.path())
            .join("facts")
            .join("01JXFORCE0000000000000001.md");
        std::fs::create_dir_all(fact_path.parent().unwrap()).unwrap();
        std::fs::write(
            &fact_path,
            "---\nid: 01JXFORCE0000000000000001\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nforce push fact",
        )
        .unwrap();

        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let report = sync_once(
            &mut store,
            tmp.path(),
            &SyncOpts {
                do_pull: true,
                do_push: true,
                message: Some("manual sync".into()),
            },
            None,
        )
        .unwrap();

        assert!(report.pushed, "manual sync should ignore auto_push=false");
        assert!(report.skipped_reason.is_none());
    }

    // ── auto_init ──

    #[test]
    fn commit_and_push_auto_init_when_no_config() {
        if !has_git() {
            eprintln!("[test] git not found, skipping");
            return;
        }
        let tmp = init_test_root();

        // 写入一条 fact(模拟 approve 后的状态)
        let fact_path = vault_dir(tmp.path())
            .join("facts")
            .join("01JXAUTO000000000000000001.md");
        std::fs::create_dir_all(fact_path.parent().unwrap()).unwrap();
        std::fs::write(&fact_path, "---\nid: 01JXAUTO000000000000000001\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nauto-init test").unwrap();

        // 没有任何 sync.json → commit_and_push 应自动初始化
        let pushed = commit_and_push(tmp.path(), "auto: first approve").unwrap();
        assert!(pushed, "should auto-init and commit");

        // 验证 git repo 已创建
        assert!(is_git_repo(tmp.path()));
        assert!(vault_dir(tmp.path()).join(".gitattributes").exists());
        assert!(vault_dir(tmp.path()).join(".gitignore").exists());

        // 验证 sync.json 已创建
        let cfg = load_config(tmp.path()).unwrap();
        assert!(cfg.auto_sync);
        assert!(cfg.auto_push, "auto_init should enable auto_push");
        assert!(cfg.remote.is_none());

        // 验证有 commit
        let log = git(tmp.path(), &["log", "--oneline"]).unwrap();
        let log_str = String::from_utf8_lossy(&log.stdout);
        assert!(log_str.contains("auto: first approve"));

        // 第二次 commit 不应重复 init
        std::fs::write(&fact_path, "---\nid: 01JXAUTO000000000000000001\nauthor: test\nscope: project:test\ncreated: 2026-06-13T00:00:00Z\nconfidence: 0.9\ntags: []\n---\n\nupdated").unwrap();
        let pushed2 = commit_and_push(tmp.path(), "auto: second approve").unwrap();
        assert!(pushed2);
    }
}
