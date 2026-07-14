use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
    pub bucket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub display_name: String,
    pub current: bool,
    pub remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp_secs: u64,
    pub subject: String,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub decorations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WorkspaceGitSummary {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub short_head: Option<String>,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicts: u32,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
    #[serde(default)]
    pub branches: Vec<GitBranchInfo>,
    #[serde(default)]
    pub commits: Vec<GitCommitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub path: String,
    pub exists: bool,
    pub entries: Vec<WorkspaceEntry>,
    pub git: WorkspaceGitSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePreview {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    #[serde(default)]
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffPreview {
    pub path: String,
    pub bucket: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitFileChange {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitDetail {
    pub commit: String,
    pub message: String,
    pub files: Vec<GitCommitFileChange>,
}

#[tauri::command]
pub async fn workspace_snapshot(
    cwd: String,
    show_hidden: Option<bool>,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace_snapshot_sync(&cwd, show_hidden.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("workspace snapshot task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_list_dir(
    path: String,
    show_hidden: Option<bool>,
) -> Result<Vec<WorkspaceEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = absolute_path(&path)?;
        if !path.is_dir() {
            return Err(format!("not a directory: {}", path.display()));
        }
        list_workspace_entries(&path, show_hidden.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("workspace list task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_preview_file(path: String) -> Result<FilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_file_sync(&path))
        .await
        .map_err(|e| format!("workspace preview task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_git_diff(
    cwd: String,
    path: String,
    bucket: String,
) -> Result<GitDiffPreview, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_sync(&cwd, &path, &bucket))
        .await
        .map_err(|e| format!("workspace git diff task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_git_commit_diff(
    cwd: String,
    commit: String,
) -> Result<GitDiffPreview, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_diff_sync(&cwd, &commit))
        .await
        .map_err(|e| format!("workspace git commit diff task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_git_commit_detail(
    cwd: String,
    commit: String,
) -> Result<GitCommitDetail, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_detail_sync(&cwd, &commit))
        .await
        .map_err(|e| format!("workspace git commit detail task failed: {e}"))?
}

#[tauri::command]
pub async fn workspace_git_commit_file_diff(
    cwd: String,
    commit: String,
    path: String,
) -> Result<GitDiffPreview, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_file_diff_sync(&cwd, &commit, &path))
        .await
        .map_err(|e| format!("workspace git commit file diff task failed: {e}"))?
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open_path_sync(&path)
}

fn workspace_snapshot_sync(cwd: &str, show_hidden: bool) -> Result<WorkspaceSnapshot, String> {
    let path = absolute_path(cwd)?;
    let exists = path.is_dir();
    let entries = if exists {
        list_workspace_entries(&path, show_hidden)?
    } else {
        Vec::new()
    };
    let git = if exists {
        read_git_summary(&path)
    } else {
        WorkspaceGitSummary::default()
    };

    Ok(WorkspaceSnapshot {
        path: path.to_string_lossy().into_owned(),
        exists,
        entries,
        git,
    })
}

fn absolute_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    Ok(path)
}

fn list_workspace_entries(path: &Path, show_hidden: bool) -> Result<Vec<WorkspaceEntry>, String> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|e| format!("read workspace {}: {e}", path.display()))?
        .filter_map(Result::ok)
        // .git 始终过滤(与 bridge /api/v1/fs/list 一致),即便 show_hidden=true 也不展示
        .filter(|entry| entry.file_name().to_string_lossy() != ".git")
        .filter(|entry| {
            // dotfiles 受 show_hidden 开关控制;默认本地 show_hidden=true 保留旧行为
            show_hidden || !entry.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(|entry| entry_to_workspace_entry(entry))
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(160);
    Ok(entries)
}

fn entry_to_workspace_entry(entry: std::fs::DirEntry) -> Option<WorkspaceEntry> {
    let name = entry.file_name().to_string_lossy().into_owned();
    let file_type = entry.file_type().ok()?;
    let metadata = entry.metadata().ok();
    let modified_secs = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Some(WorkspaceEntry {
        name,
        path: entry.path().to_string_lossy().into_owned(),
        is_dir: file_type.is_dir(),
        is_symlink: file_type.is_symlink(),
        size: metadata
            .as_ref()
            .filter(|_| !file_type.is_dir())
            .map(|m| m.len()),
        modified_secs,
    })
}

fn preview_file_sync(raw: &str) -> Result<FilePreview, String> {
    const MAX_BYTES: usize = 220 * 1024;
    const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024; // 10MB
    let path = absolute_path(raw)?;
    if path.is_dir() {
        return Err(format!(
            "expected a file, got directory: {}",
            path.display()
        ));
    }
    let metadata = std::fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let size = metadata.len();
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    // Image detection by extension — before null-byte binary check, since
    // images are binary but we want to render them inline as <img>.
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if let Some(mime) = image_mime_for_ext(&ext) {
        if size > MAX_IMAGE_BYTES as u64 {
            return Ok(FilePreview {
                path: path.to_string_lossy().into_owned(),
                name,
                kind: "image".into(),
                content: String::new(),
                size,
                truncated: true,
                mime,
            });
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(FilePreview {
            path: path.to_string_lossy().into_owned(),
            name,
            kind: "image".into(),
            content: b64,
            size,
            truncated: false,
            mime,
        });
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let truncated = bytes.len() > MAX_BYTES;
    let sample = &bytes[..bytes.len().min(MAX_BYTES)];

    if sample.iter().any(|b| *b == 0) {
        return Ok(FilePreview {
            path: path.to_string_lossy().into_owned(),
            name,
            kind: "binary".into(),
            content: String::new(),
            size,
            truncated,
            mime: String::new(),
        });
    }

    let content = String::from_utf8_lossy(sample).into_owned();
    Ok(FilePreview {
        path: path.to_string_lossy().into_owned(),
        name,
        kind: "text".into(),
        content,
        size,
        truncated,
        mime: String::new(),
    })
}

/// Map image file extension to MIME type. Returns None for non-image extensions.
fn image_mime_for_ext(ext: &str) -> Option<String> {
    match ext {
        "png" => Some("image/png".into()),
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "gif" => Some("image/gif".into()),
        "webp" => Some("image/webp".into()),
        "svg" => Some("image/svg+xml".into()),
        "bmp" => Some("image/bmp".into()),
        "ico" => Some("image/x-icon".into()),
        _ => None,
    }
}

fn read_git_summary(path: &Path) -> WorkspaceGitSummary {
    let Some(root) = run_git(path, &["rev-parse", "--show-toplevel"]) else {
        return WorkspaceGitSummary::default();
    };
    let branch = run_git(path, &["branch", "--show-current"]).filter(|s| !s.is_empty());
    let short_head = run_git(path, &["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty());
    let mut summary = WorkspaceGitSummary {
        is_repo: true,
        root: Some(root),
        branch,
        short_head,
        branches: read_git_branches(path),
        commits: read_git_commits(path),
        ..Default::default()
    };

    if let Some(status) = run_git(path, &["status", "--porcelain=v1", "--branch"]) {
        parse_git_status(&status, &mut summary, "");
    }
    // porcelain v1 把 submodule 折叠成单个 M 条目,内部文件不可见。
    // 逐个进 submodule 跑 status,前缀聚合进来 —— 这样 Git 面板能看到子模块内部改动。
    collect_submodule_changes(path, &mut summary);
    summary
}

fn read_git_branches(path: &Path) -> Vec<GitBranchInfo> {
    let Some(output) = run_git(
        path,
        &[
            "branch",
            "--all",
            "--format=%(refname)%x1f%(refname:short)%x1f%(HEAD)",
        ],
    ) else {
        return Vec::new();
    };
    parse_git_branches(&output)
}

fn parse_git_branches(output: &str) -> Vec<GitBranchInfo> {
    let mut branches = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in output.lines() {
        let mut parts = line.split('\x1f');
        let Some(refname) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(short) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if refname.starts_with("refs/remotes/") && refname.ends_with("/HEAD") {
            continue;
        }
        if !seen.insert(short.to_string()) {
            continue;
        }
        branches.push(GitBranchInfo {
            name: short.to_string(),
            display_name: short.to_string(),
            current: parts.next().map(str::trim) == Some("*"),
            remote: refname.starts_with("refs/remotes/"),
        });
    }
    branches
}

fn read_git_commits(path: &Path) -> Vec<GitCommitInfo> {
    let Some(output) = run_git(
        path,
        &[
            "log",
            "--all",
            "-n",
            "80",
            "--date=unix",
            "--decorate=full",
            "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1f%P%x1f%D",
        ],
    ) else {
        return Vec::new();
    };
    parse_git_commits(&output)
}

fn parse_git_commits(output: &str) -> Vec<GitCommitInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\x1f');
            let hash = parts.next()?.trim();
            let short_hash = parts.next()?.trim();
            let author = parts.next()?.trim();
            let timestamp_secs = parts.next()?.trim().parse().ok()?;
            let subject = parts.next().unwrap_or_default().trim();
            let parents = parse_commit_parents(parts.next().unwrap_or_default());
            let decorations = parse_commit_decorations(parts.next().unwrap_or_default());
            Some(GitCommitInfo {
                hash: hash.to_string(),
                short_hash: short_hash.to_string(),
                author: author.to_string(),
                timestamp_secs,
                subject: subject.to_string(),
                parents,
                decorations,
            })
        })
        .collect()
}

fn parse_commit_parents(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_commit_decorations(raw: &str) -> Vec<String> {
    let mut labels = Vec::new();
    for part in raw.split(',') {
        let label = part
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim();
        if label.is_empty() {
            continue;
        }
        if let Some(branch) = label.strip_prefix("HEAD -> ") {
            labels.push("HEAD".to_string());
            if let Some(cleaned) = clean_decoration_label(branch) {
                labels.push(cleaned);
            }
        } else if let Some(cleaned) = clean_decoration_label(label) {
            labels.push(cleaned);
        }
    }
    labels
}

fn clean_decoration_label(label: &str) -> Option<String> {
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    let cleaned = label
        .strip_prefix("refs/heads/")
        .or_else(|| label.strip_prefix("refs/remotes/"))
        .map(str::to_string)
        .or_else(|| {
            label
                .strip_prefix("tag: refs/tags/")
                .map(|tag| format!("tag: {tag}"))
        })
        .or_else(|| {
            label
                .strip_prefix("refs/tags/")
                .map(|tag| format!("tag: {tag}"))
        })
        .unwrap_or_else(|| label.to_string());
    Some(cleaned)
}

/// 枚举已 checkout 的 submodule,在每个子模块内部跑 `git status --porcelain`,
/// 把改动以 `<sub_path>/<inner>` 前缀聚合进 superproject 的 summary。
/// `git submodule status --recursive` 递归覆盖嵌套子模块。
fn collect_submodule_changes(root: &Path, summary: &mut WorkspaceGitSummary) {
    let Some(out) = run_git(root, &["submodule", "status", "--recursive"]) else {
        return;
    };
    for line in out.lines() {
        // 行格式: " <sha> <path> (<desc>)"  /  "-<sha> <path>"(未初始化,跳过)
        if line.starts_with('-') {
            continue;
        }
        let trimmed = line.trim_start();
        let mut parts = trimmed.split_whitespace();
        let _sha = parts.next();
        let Some(sub_path) = parts.next() else {
            continue;
        };
        let sub_abs = root.join(sub_path);
        if !sub_abs.is_dir() {
            continue;
        }
        if let Some(sub_status) = run_git(&sub_abs, &["status", "--porcelain=v1", "--branch"]) {
            parse_git_status(&sub_status, summary, &format!("{sub_path}/"));
        }
    }
}

fn parse_git_status(status: &str, summary: &mut WorkspaceGitSummary, prefix: &str) {
    for line in status.lines() {
        if let Some(branch_line) = line.strip_prefix("## ") {
            parse_git_ahead_behind(branch_line, summary);
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let raw_path = line[3..].trim();
        let path = raw_path
            .rsplit_once(" -> ")
            .map(|(_, to)| to)
            .unwrap_or(raw_path)
            .to_string();
        // submodule 聚合时,prefix = "<sub_path>/" —— 把子模块内部路径前缀成
        // superproject 视角的完整路径,前端点击时才能拿对路径去 diff。
        let path = if prefix.is_empty() {
            path
        } else {
            format!("{prefix}{path}")
        };

        if xy == "??" {
            summary.untracked += 1;
            summary.changes.push(GitChange {
                path,
                status: "untracked".into(),
                bucket: "untracked".into(),
            });
            continue;
        }

        let mut chars = xy.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        if is_conflict(x, y) {
            summary.conflicts += 1;
            summary.changes.push(GitChange {
                path,
                status: xy.trim().into(),
                bucket: "conflict".into(),
            });
            continue;
        }
        if x != ' ' {
            summary.staged += 1;
            summary.changes.push(GitChange {
                path: path.clone(),
                status: status_label(x),
                bucket: "staged".into(),
            });
        }
        if y != ' ' {
            summary.modified += 1;
            summary.changes.push(GitChange {
                path,
                status: status_label(y),
                bucket: "modified".into(),
            });
        }
    }
}

fn is_conflict(x: char, y: char) -> bool {
    (matches!(x, 'U' | 'A' | 'D') && y == 'U')
        || x == 'U'
        || (matches!(y, 'U' | 'A' | 'D') && x == 'U')
}

fn status_label(c: char) -> String {
    match c {
        'A' => "added",
        'D' => "deleted",
        'M' => "modified",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type changed",
        _ => "changed",
    }
    .into()
}

fn parse_git_ahead_behind(branch_line: &str, summary: &mut WorkspaceGitSummary) {
    let Some(start) = branch_line.find('[') else {
        return;
    };
    let Some(end) = branch_line[start + 1..].find(']') else {
        return;
    };
    let detail = &branch_line[start + 1..start + 1 + end];
    for part in detail.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            summary.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            summary.behind = n.parse().unwrap_or(0);
        }
    }
}

fn git_diff_sync(cwd: &str, path: &str, bucket: &str) -> Result<GitDiffPreview, String> {
    const MAX_CHARS: usize = 180_000;
    let cwd = absolute_path(cwd)?;
    let root = run_git(&cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "not a Git repository".to_string())?;
    let root_path = PathBuf::from(&root);
    let rel = path.trim();
    if rel.is_empty() || rel.starts_with('/') || rel.contains("..") {
        return Err("git path must be a repository-relative path".into());
    }

    // 路径可能落在 submodule 内 —— superproject root 跑 diff 拿不到子模块内部改动。
    // 探测文件所在的实际 repo toplevel,若与 superproject root 不同则重路由到子模块。
    let (diff_root, diff_rel) = resolve_diff_target(&root_path, rel);

    let output = if bucket == "staged" {
        run_git_raw(
            &diff_root,
            &["--no-pager", "diff", "--cached", "--", &diff_rel],
        )?
    } else if bucket == "untracked" {
        let full_path = diff_root.join(&diff_rel);
        run_diff_no_index(&full_path)?
    } else {
        run_git_raw(&diff_root, &["--no-pager", "diff", "--", &diff_rel])?
    };

    let (content, truncated) = truncate_chars(output, MAX_CHARS);
    Ok(GitDiffPreview {
        path: rel.to_string(),
        bucket: bucket.to_string(),
        content,
        truncated,
    })
}

fn git_commit_diff_sync(cwd: &str, commit: &str) -> Result<GitDiffPreview, String> {
    const MAX_CHARS: usize = 180_000;
    let cwd = absolute_path(cwd)?;
    let root = run_git(&cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "not a Git repository".to_string())?;
    let commit = commit.trim();
    if !is_valid_commit_hash(commit) {
        return Err("commit must be a 7-40 character hex SHA".into());
    }
    let output = run_git_raw(
        Path::new(&root),
        &[
            "--no-pager",
            "show",
            "--format=fuller",
            "--stat",
            "--patch",
            "--no-ext-diff",
            "--find-renames",
            commit,
        ],
    )?;
    let (content, truncated) = truncate_chars(output, MAX_CHARS);
    Ok(GitDiffPreview {
        path: commit.to_string(),
        bucket: "commit".into(),
        content,
        truncated,
    })
}

fn git_commit_detail_sync(cwd: &str, commit: &str) -> Result<GitCommitDetail, String> {
    let cwd = absolute_path(cwd)?;
    let root = run_git(&cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "not a Git repository".to_string())?;
    let commit = commit.trim();
    if !is_valid_commit_hash(commit) {
        return Err("commit must be a 7-40 character hex SHA".into());
    }
    let output = run_git_raw(
        Path::new(&root),
        &[
            "--no-pager",
            "show",
            "--format=%B%x1e",
            "--name-status",
            "--no-renames",
            commit,
        ],
    )?;
    Ok(parse_commit_detail(commit, &output))
}

fn git_commit_file_diff_sync(
    cwd: &str,
    commit: &str,
    path: &str,
) -> Result<GitDiffPreview, String> {
    const MAX_CHARS: usize = 180_000;
    let cwd = absolute_path(cwd)?;
    let root = run_git(&cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "not a Git repository".to_string())?;
    let commit = commit.trim();
    if !is_valid_commit_hash(commit) {
        return Err("commit must be a 7-40 character hex SHA".into());
    }
    let rel = validate_git_rel_path(path)?;
    let output = run_git_raw(
        Path::new(&root),
        &[
            "--no-pager",
            "show",
            "--format=",
            "--patch",
            "--no-ext-diff",
            "--find-renames",
            commit,
            "--",
            rel,
        ],
    )?;
    let (content, truncated) = truncate_chars(output, MAX_CHARS);
    Ok(GitDiffPreview {
        path: rel.to_string(),
        bucket: "commit-file".into(),
        content,
        truncated,
    })
}

fn parse_commit_detail(commit: &str, output: &str) -> GitCommitDetail {
    let (message, files_raw) = output.split_once('\x1e').unwrap_or((output, ""));
    GitCommitDetail {
        commit: commit.to_string(),
        message: message.trim().to_string(),
        files: parse_commit_file_changes(files_raw),
    }
}

fn parse_commit_file_changes(raw: &str) -> Vec<GitCommitFileChange> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut parts = trimmed.split('\t');
            let status = parts.next()?.trim();
            let path = parts.next_back().or_else(|| parts.next())?.trim();
            if status.is_empty() || path.is_empty() {
                return None;
            }
            Some(GitCommitFileChange {
                path: path.to_string(),
                status: status.to_string(),
            })
        })
        .collect()
}

fn validate_git_rel_path(path: &str) -> Result<&str, String> {
    let rel = path.trim();
    if rel.is_empty() || rel.starts_with('/') || rel.contains("..") {
        return Err("git path must be a repository-relative path".into());
    }
    Ok(rel)
}

fn is_valid_commit_hash(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 判断 `rel` 是否落在某个 submodule 内。若是,返回 `(submodule_root, 子模块内相对路径)`;
/// 否则返回 `(root, rel)` 不变。做法:从文件父目录向上找第一个存在的目录,跑
/// `git rev-parse --show-toplevel` —— 子模块内的文件解析出的 toplevel 会不同于
/// superproject root。文件可能已删除,所以向上 walk 到第一个存在的目录再探测。
fn resolve_diff_target(root: &Path, rel: &str) -> (PathBuf, String) {
    let full = root.join(rel);
    let mut probe = full.parent();
    while let Some(p) = probe {
        if p.is_dir() {
            if let Some(sub_root) = run_git(p, &["rev-parse", "--show-toplevel"]) {
                let sub_root_path = PathBuf::from(&sub_root);
                if sub_root_path != root {
                    if let Ok(inner) = full.strip_prefix(&sub_root_path) {
                        return (sub_root_path, inner.to_string_lossy().into_owned());
                    }
                }
            }
            break;
        }
        probe = p.parent();
    }
    (root.to_path_buf(), rel.to_string())
}

fn run_git(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_raw(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("git failed: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_diff_no_index(path: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .args(["--no-pager", "diff", "--no-index", "--"])
        .arg("/dev/null")
        .arg(path)
        .output()
        .map_err(|e| format!("git diff failed: {e}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn truncate_chars(mut content: String, max_chars: usize) -> (String, bool) {
    if content.chars().count() <= max_chars {
        return (content, false);
    }
    let mut end = 0;
    for (idx, _) in content.char_indices().take(max_chars) {
        end = idx;
    }
    content.truncate(end);
    content.push_str("\n\n... truncated ...\n");
    (content, true)
}

fn open_path_sync(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }

    let expanded: std::borrow::Cow<str> = if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            std::borrow::Cow::Owned(home.join(rest).to_string_lossy().into_owned())
        } else {
            std::borrow::Cow::Borrowed(trimmed)
        }
    } else {
        std::borrow::Cow::Borrowed(trimmed)
    };

    let s = expanded.as_ref();
    let is_abs_path = s.starts_with('/');
    let is_url = s.starts_with("http://") || s.starts_with("https://") || s.starts_with("file://");
    if !is_abs_path && !is_url {
        return Err(format!(
            "rejected: not an absolute path or http(s) URL: {s}"
        ));
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(s)
            .spawn()
            .map_err(|e| format!("open failed: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(s)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {e}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        return Err("open_path not supported on this platform".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_branches_and_skips_remote_head_alias() {
        let branches = parse_git_branches(
            "refs/heads/main\x1fmain\x1f*\nrefs/remotes/origin/HEAD\x1forigin/HEAD\x1f \nrefs/remotes/origin/feature\x1forigin/feature\x1f ",
        );
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current);
        assert!(!branches[0].remote);
        assert_eq!(branches[1].name, "origin/feature");
        assert!(!branches[1].current);
        assert!(branches[1].remote);
    }

    #[test]
    fn parses_git_commits_with_graph_metadata() {
        let commits = parse_git_commits(
            "0123456789abcdef\x1f0123456\x1fAlice\x1f1720000000\x1fadd history view\x1fabcdef0 1111111\x1fHEAD -> main, origin/main, tag: v1\nfedcba9876543210\x1ffedcba9\x1fBob\x1f1720000100\x1froot commit\x1f\x1f",
        );
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "0123456789abcdef");
        assert_eq!(commits[0].short_hash, "0123456");
        assert_eq!(commits[0].author, "Alice");
        assert_eq!(commits[0].timestamp_secs, 1720000000);
        assert_eq!(commits[0].subject, "add history view");
        assert_eq!(commits[0].parents, vec!["abcdef0", "1111111"]);
        assert_eq!(
            commits[0].decorations,
            vec!["HEAD", "main", "origin/main", "tag: v1"]
        );
        assert!(commits[1].parents.is_empty());
        assert!(commits[1].decorations.is_empty());
    }

    #[test]
    fn parses_full_ref_decorations() {
        let labels = parse_commit_decorations(
            "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1",
        );
        assert_eq!(labels, vec!["HEAD", "main", "origin/main", "tag: v1"]);
    }

    #[test]
    fn parses_commit_detail_file_changes() {
        let detail = parse_commit_detail(
            "0123456",
            "full message\n\nbody\x1e\nM\tapps/gui/src/lib/WorkspacePanel.svelte\nA\tnew-file.txt\n",
        );
        assert_eq!(detail.commit, "0123456");
        assert_eq!(detail.message, "full message\n\nbody");
        assert_eq!(detail.files.len(), 2);
        assert_eq!(detail.files[0].status, "M");
        assert_eq!(
            detail.files[0].path,
            "apps/gui/src/lib/WorkspacePanel.svelte"
        );
    }

    #[test]
    fn validates_commit_hashes() {
        assert!(is_valid_commit_hash("0123456"));
        assert!(is_valid_commit_hash(
            "0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(!is_valid_commit_hash("012345"));
        assert!(!is_valid_commit_hash("main"));
        assert!(!is_valid_commit_hash("0123456..abcdef0"));
    }

    #[test]
    fn image_preview_returns_base64_for_png() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "kode-test-img-{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Minimal 1x1 red PNG
        let png_bytes: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        ];
        std::fs::write(&path, png_bytes).unwrap();
        let result = preview_file_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(result.kind, "image");
        assert_eq!(result.mime, "image/png");
        assert!(!result.content.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn svg_rendered_as_image() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "kode-test-img-{}.svg",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, "<svg></svg>").unwrap();
        let result = preview_file_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(result.kind, "image");
        assert_eq!(result.mime, "image/svg+xml");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn text_file_still_works() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "kode-test-img-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, "hello world").unwrap();
        let result = preview_file_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(result.kind, "text");
        assert_eq!(result.mime, "");
        assert_eq!(result.content, "hello world");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn binary_file_still_works() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "kode-test-img-{}.bin",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, [0u8, 1, 0, 2, 0]).unwrap();
        let result = preview_file_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(result.kind, "binary");
        assert_eq!(result.mime, "");
        let _ = std::fs::remove_file(&path);
    }
}
