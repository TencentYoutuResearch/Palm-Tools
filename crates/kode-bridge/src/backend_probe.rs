//! Backend 探测:`which` 工具 + backend 列表过滤。
//!
//! bridge 的 `GET /api/v1/backends` 需要只返回远端机器上**实际可执行**的 backend。
//! `config.toml` 里的 `enabled` flag 只反映用户在 Settings 里的开关,不能判断"装没装"。
//! 本地 GUI 端靠 `backend_admin::detect_known_backends` 在首次启动时探测 PATH 并把
//! 结果写回 config.toml;远端 bridge 没有这个落盘流程,所以在响应时即时探测一次。
//!
//! `which` 跟 `apps/gui/src-tauri/src/backend_admin::which` 同源,故意不抽到 kode-core:
//! backend_admin 注释说明了"两个独立关注点,复制可接受"。

use std::path::PathBuf;

/// 在 `$PATH` 上找可执行文件;`name` 是绝对/相对路径时直接检查该文件。
///
/// Unix 下还会校验可执行位(`mode & 0o111`)。
pub fn which(name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(name);
    // 绝对 / 相对路径直接检查文件本身,不拼 PATH。
    // (Rust 的 `PathBuf::join("/abs")` 会吞掉前缀返回 `/abs`,但显式区分更清晰。)
    if p.is_absolute() || p.components().count() > 1 {
        return check_executable(&p);
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if let Some(found) = check_executable(&cand) {
            return Some(found);
        }
    }
    None
}

fn check_executable(p: &PathBuf) -> Option<PathBuf> {
    if !p.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(p).ok()?;
        if m.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(p.clone())
}
