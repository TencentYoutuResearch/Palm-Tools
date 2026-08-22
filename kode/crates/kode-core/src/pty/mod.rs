//! PtyHost:封装一个子进程的 PTY 主从端、读写句柄、reaper。

pub mod reader;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use crate::event::CoreEvent;
use crate::session::SessionId;

/// 写入端句柄(传给 App 用于 keyboard / mouse passthrough)
pub type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct PtyHost {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: PtyWriter,
    /// 独立的 kill 句柄,clone 自 child,不依赖 child 锁,可以在 reaper 阻塞 wait 时安全 kill。
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub reader_join: Option<JoinHandle<()>>,
    pub reaper_join: Option<JoinHandle<()>>,
    pub size: PtySize,
}

impl PtyHost {
    /// 启动子进程并接好读取线程 + 退出 reaper 线程。
    ///
    /// `cwd`:子进程的工作目录。**必须显式给**,不再隐式从 `std::env::current_dir()` 拿
    /// —— 那会把 kode 进程自身的 cwd 传给子进程(典型坑:`./run.sh dev` 时
    /// kode 的 cwd 是仓库根,codebuddy 会以为用户在编辑 kode 源码)。
    /// GUI 调用方负责决定语义(默认 $HOME / KODE_CWD env / 配置 / 未来由 UI 选)。
    ///
    /// `extra_env`:注入到子进程 env 的额外键值对(追加/覆盖,不清空父进程 env)。
    /// 典型用途:注入 `KODE_HOOK_SOCK` 让 hook command(`$KODE_HOOK_SOCK`)能定位 relay socket。
    pub fn spawn(
        id: SessionId,
        command: &str,
        args: &[String],
        size: PtySize,
        cwd: &std::path::Path,
        evt_tx: mpsc::UnboundedSender<CoreEvent>,
        extra_env: &[(String, String)],
    ) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(size).context("openpty failed")?;

        let command_to_spawn = resolve_spawn_command(command);
        let mut cmd = CommandBuilder::new(command_to_spawn.as_str());
        for a in args {
            cmd.arg(a);
        }
        cmd.cwd(cwd);

        // PTY 子进程必须有 TERM/COLORTERM,否则 codebuddy/claude 等子 CLI
        // 会判定终端不支持颜色,输出全部退化为无色 → 视觉上"右边没颜色"。
        //
        // 双击 .app 启动 vs `pnpm dev`(从终端启动)的差异:
        //   - 终端启动:进程继承 shell 的 TERM=xterm-256color / COLORTERM=truecolor
        //   - 双击 .app:launchd 不设这两个环境变量,CommandBuilder 拿到的
        //     `std::env::vars_os()` 也就没有它们,子进程默认无色
        //
        // 这里**只在父进程没有时**兜底设置,不覆盖用户/终端已有的值
        // (例如用户在 iTerm 里有 COLORTERM=truecolor,我们不应该降级到默认)。
        if std::env::var_os("TERM").is_none() {
            cmd.env("TERM", "xterm-256color");
        }
        if std::env::var_os("COLORTERM").is_none() {
            cmd.env("COLORTERM", "truecolor");
        }

        // TUI 主题提示:cursor-agent / Claude `theme: auto` / OpenCode / bat / vim
        // 都会读这些变量。GUI 通过 extra_env 传入 Kode xterm 的真实 light/dark;
        // legacy TUI 则保留外层终端已经提供的提示。两边都没有时才默认 dark,
        // 避免子 CLI 的 OSC 11 探测在 PTY 转发链路上超时。
        apply_terminal_theme_env(&mut cmd, extra_env);

        // 注入调用方提供的额外 env(追加/覆盖,不清空父进程 env)。
        // 典型:KODE_HOOK_SOCK — hook command 里的 $KODE_HOOK_SOCK 引用此变量
        // 定位 relay socket,无需把含 PID 的动态路径写死进 settings.json。
        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        // locale 兜底:.app 双击启动时 launchd 不会注入 LANG/LC_*,git/grep 等会
        // 退化到 C/POSIX,把非 ASCII 字节转义成 \xxx 输出,xterm.js 按 UTF-8 解码
        // 后变成 � 乱码(从外部终端跑 `pnpm dev` 时正常,因为继承了 shell 的 LANG)。
        //
        // 策略:LC_ALL / LANG / LC_CTYPE 任何一个已存在就不动(尊重用户设置);
        // 全都缺失时才注入 LANG=en_US.UTF-8(macOS 系统自带,Linux 通常也有)。
        let has_locale = std::env::var_os("LC_ALL").is_some()
            || std::env::var_os("LANG").is_some()
            || std::env::var_os("LC_CTYPE").is_some();
        if !has_locale {
            cmd.env("LANG", "en_US.UTF-8");
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .context("spawn child failed")?;

        // 在把 child move 进 reaper 之前,拿一个独立的 killer 句柄
        let killer = child.clone_killer();

        // master 的 reader/writer 必须从 master 上拿
        let reader = pair
            .master
            .try_clone_reader()
            .context("clone pty reader failed")?;
        let writer_box = pair
            .master
            .take_writer()
            .context("take pty writer failed")?;

        let writer: PtyWriter = Arc::new(Mutex::new(writer_box));

        // 阻塞读线程
        let reader_join = reader::spawn_reader(id, reader, evt_tx.clone());

        // reaper:等子进程退出,通知 App
        // child 直接 move 进 reaper 线程(不再共享),wait 不会阻塞外部
        let reaper_join = std::thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            let _ = evt_tx.send(CoreEvent::PtyExited {
                id,
                code: Some(code),
            });
        });

        Ok(Self {
            master: pair.master,
            writer,
            killer: Mutex::new(killer),
            reader_join: Some(reader_join),
            reaper_join: Some(reaper_join),
            size,
        })
    }

    /// 调整子进程的窗口尺寸(触发 SIGWINCH)
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let size = PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        };
        self.master.resize(size).context("pty resize failed")?;
        self.size = size;
        Ok(())
    }

    /// 写字节给子进程 stdin
    pub fn write_all(&self, bytes: &[u8]) -> Result<()> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("pty writer poisoned"))?;
        guard.write_all(bytes).context("pty write failed")?;
        guard.flush().ok();
        Ok(())
    }

    /// 强制 kill 子进程(用于退出时清理)
    pub fn kill(&self) {
        if let Ok(mut guard) = self.killer.lock() {
            let _ = guard.kill();
        }
    }
}

/// Parse a theme hint from spawn IPC / env (`"dark"` / `"light"`).
pub fn parse_term_theme(value: Option<&str>) -> Option<bool> {
    match value.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("dark") => Some(true),
        Some("light") => Some(false),
        _ => None,
    }
}

/// Env vars that tell child TUIs the host terminal is dark or light.
///
/// - `TERM_THEME`: cursor-agent reads this first and skips its ~100ms OSC 11 probe.
/// - `COLORFGBG`: Claude Code `theme: auto`, OpenCode, vim, bat, delta read this
///   synchronously at startup (`15;0` = white on black, `0;15` = black on white).
pub fn terminal_theme_env(dark: bool) -> Vec<(String, String)> {
    if dark {
        vec![
            ("TERM_THEME".into(), "dark".into()),
            ("COLORFGBG".into(), "15;0".into()),
        ]
    } else {
        vec![
            ("TERM_THEME".into(), "light".into()),
            ("COLORFGBG".into(), "0;15".into()),
        ]
    }
}

/// Stamp default dark theme hints unless the parent env or `extra_env` already
/// set the same keys. GUI's explicit `extra_env` is applied after this helper
/// and therefore remains authoritative.
pub fn apply_terminal_theme_env(cmd: &mut CommandBuilder, extra_env: &[(String, String)]) {
    for (k, v) in terminal_theme_env(true) {
        if cmd.get_env(&k).is_none() && !extra_env.iter().any(|(ek, _)| ek == &k) {
            cmd.env(&k, &v);
        }
    }
}

fn resolve_spawn_command(command: &str) -> String {
    if command.contains('/') || command.contains('\\') {
        return command.to_string();
    }
    if let Some(path) = which(command) {
        return path.display().to_string();
    }
    if command == "codebuddy" {
        for cand in codebuddy_fallback_paths() {
            if is_executable(&cand) {
                return cand.display().to_string();
            }
        }
    }
    if command == "codex" {
        for cand in codex_fallback_paths() {
            if is_executable(&cand) {
                return cand.display().to_string();
            }
        }
    }
    // 通用兜底(2026-08):cursor-agent 报过这个坑之后审计了其它预置 backend
    // (kimi / opencode / grok / kiro-cli 等)的官方安装脚本,发现它们同样倾向于
    // 把二进制放进 `~/.local/bin` 这个事实上的"用户级 bin 目录"约定,而不保证
    // 落在标准 Homebrew/npm 全局路径里。与其给每个新 backend 单独写一个
    // `<name>_fallback_paths()`(codebuddy/codex 因为还有额外特殊候选路径才
    // 那么写,继续保留),这里做一次通用兜底覆盖其余 backend:PATH 上找不到的
    // 任何命令,最后都试一次 `~/.local/bin/<command>`。新增预置 backend 不需要
    // 再改这个函数。
    if let Some(cand) = local_bin_fallback(command) {
        return cand.display().to_string();
    }
    command.to_string()
}

fn codebuddy_fallback_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let nvm_versions = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            let mut versions: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
            versions.reverse();
            for v in versions {
                paths.push(v.join("bin").join("codebuddy"));
            }
        }
        paths.push(home.join(".local").join("bin").join("codebuddy"));
    }
    paths
}

fn codex_fallback_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(p) = std::env::var_os("CODEX_CLI_PATH") {
        paths.push(PathBuf::from(p));
    }
    paths.push(PathBuf::from(
        "/Applications/Codex.app/Contents/Resources/codex",
    ));
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".codex").join("bin").join("codex"));
    }
    paths
}

/// 通用 `~/.local/bin/<command>` 兜底,供 `codebuddy`/`codex` 之外的预置 backend
/// 共用(cursor-agent / kimi / opencode / grok / kiro-cli 等官方安装脚本都倾向
/// 把二进制放在这个目录)。找不到候选文件或非可执行时返回 `None`。
fn local_bin_fallback(command: &str) -> Option<PathBuf> {
    let cand = dirs::home_dir()?.join(".local").join("bin").join(command);
    is_executable(&cand).then_some(cand)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if is_executable(&cand) {
            return Some(cand);
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

impl Drop for PtyHost {
    fn drop(&mut self) {
        // 兜底:确保子进程不会变僵尸
        self.kill();
        // 关闭 master 会让 reader 线程的 read 返回 EOF 自然退出
        // 不主动 join,避免 Drop 阻塞
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[test]
    fn resolve_codex_from_fallback_when_path_misses() {
        let saved_path = std::env::var_os("PATH");
        let saved_codex = std::env::var_os("CODEX_CLI_PATH");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("kode-codex-path-test-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("codex");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).unwrap();
        }
        unsafe {
            std::env::set_var("PATH", "");
            std::env::set_var("CODEX_CLI_PATH", &fake);
        }
        let resolved = resolve_spawn_command("codex");
        assert_eq!(resolved, fake.display().to_string());

        unsafe {
            match saved_path {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
            match saved_codex {
                Some(v) => std::env::set_var("CODEX_CLI_PATH", v),
                None => std::env::remove_var("CODEX_CLI_PATH"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归:`cursor-agent` 官方安装脚本默认落地 `~/.local/bin/cursor-agent`。
    /// GUI 以 `.app` 方式启动时 PATH 可能不含这个目录,spawn 必须走通用
    /// `local_bin_fallback` 而不是原样把命令名丢给 CommandBuilder(那样会直接
    /// ENOENT)。用临时 `$HOME` 验证,覆盖 cursor-agent 之外的其它预置 backend
    /// (kimi / opencode / grok / kiro-cli 等)同款风险。
    #[test]
    fn resolve_command_falls_back_to_local_bin_when_path_misses() {
        let saved_path = std::env::var_os("PATH");
        let saved_home = std::env::var_os("HOME");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home_dir = std::env::temp_dir().join(format!("kode-local-bin-home-test-{stamp}"));
        let local_bin = home_dir.join(".local").join("bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        let fake = local_bin.join("cursor-agent");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&fake).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&fake, perms).unwrap();
        }
        unsafe {
            std::env::set_var("PATH", "");
            std::env::set_var("HOME", &home_dir);
        }
        let resolved = resolve_spawn_command("cursor-agent");
        assert_eq!(resolved, fake.display().to_string());

        unsafe {
            match saved_path {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
            match saved_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
        let _ = std::fs::remove_dir_all(&home_dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_reads_echo_output() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let host = PtyHost::spawn(
            42,
            "bash",
            &["-c".into(), "echo HELLO_FROM_PTY; sleep 0.2".into()],
            portable_pty::PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            std::path::Path::new("/tmp"),
            tx,
            &[],
        )
        .expect("spawn");

        let mut got = Vec::<u8>::new();
        let _ = timeout(Duration::from_secs(2), async {
            while let Some(act) = rx.recv().await {
                match act {
                    CoreEvent::PtyBytes { bytes, .. } => {
                        got.extend(bytes);
                        if String::from_utf8_lossy(&got).contains("HELLO_FROM_PTY") {
                            break;
                        }
                    }
                    CoreEvent::PtyExited { .. } => break,
                    _ => {}
                }
            }
        })
        .await;
        drop(host);

        let s = String::from_utf8_lossy(&got);
        assert!(s.contains("HELLO_FROM_PTY"), "got: {:?}", s);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn exit_code_propagates() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let host = PtyHost::spawn(
            7,
            "bash",
            &["-c".into(), "exit 13".into()],
            portable_pty::PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            std::path::Path::new("/tmp"),
            tx,
            &[],
        )
        .expect("spawn");

        let mut code = None;
        let _ = timeout(Duration::from_secs(2), async {
            while let Some(act) = rx.recv().await {
                if let CoreEvent::PtyExited { code: c, .. } = act {
                    code = c;
                    break;
                }
            }
        })
        .await;
        drop(host);

        assert_eq!(code, Some(13), "got: {:?}", code);
    }

    /// 回归:双击 .app 启动时 launchd 不传 TERM/COLORTERM,导致子 CLI(codebuddy/claude)
    /// 误判终端不支持颜色 → 视觉上"右边没颜色"。spawn 必须兜底设这两个环境变量。
    ///
    /// 用 SAFETY:`std::env::remove_var` 在 spawn 前临时移除父进程的终端能力和
    /// 主题提示,模拟 launchd 启动场景;spawn 后立即恢复,避免影响其他测试。
    /// 依赖 `--test-threads=1`(CODEBUDDY.md 已固定)。
    #[tokio::test(flavor = "multi_thread")]
    async fn spawn_sets_term_when_parent_env_missing() {
        let saved_term = std::env::var_os("TERM");
        let saved_colorterm = std::env::var_os("COLORTERM");
        let saved_term_theme = std::env::var_os("TERM_THEME");
        let saved_colorfgbg = std::env::var_os("COLORFGBG");
        // SAFETY: 测试单线程跑(--test-threads=1),且 spawn 前同步完成 env 修改。
        unsafe {
            std::env::remove_var("TERM");
            std::env::remove_var("COLORTERM");
            std::env::remove_var("TERM_THEME");
            std::env::remove_var("COLORFGBG");
        }

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let host = PtyHost::spawn(
            99,
            "bash",
            &[
                "-c".into(),
                "echo TERM=$TERM CT=$COLORTERM TT=$TERM_THEME CFG=$COLORFGBG; sleep 0.1".into(),
            ],
            portable_pty::PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            std::path::Path::new("/tmp"),
            tx,
            &[],
        )
        .expect("spawn");

        let mut got = Vec::<u8>::new();
        let _ = timeout(Duration::from_secs(2), async {
            while let Some(act) = rx.recv().await {
                if let CoreEvent::PtyBytes { bytes, .. } = act {
                    got.extend(bytes);
                    if String::from_utf8_lossy(&got).contains("CT=") {
                        break;
                    }
                }
            }
        })
        .await;
        drop(host);

        // 恢复 env(尽量不污染同进程后续测试)
        // SAFETY: 同上,单线程测试,spawn 已结束。
        unsafe {
            if let Some(v) = saved_term {
                std::env::set_var("TERM", v);
            }
            if let Some(v) = saved_colorterm {
                std::env::set_var("COLORTERM", v);
            }
            if let Some(v) = saved_term_theme {
                std::env::set_var("TERM_THEME", v);
            }
            if let Some(v) = saved_colorfgbg {
                std::env::set_var("COLORFGBG", v);
            }
        }

        let s = String::from_utf8_lossy(&got);
        assert!(
            s.contains("TERM=xterm-256color"),
            "child TERM not set, got: {:?}",
            s
        );
        assert!(
            s.contains("CT=truecolor"),
            "child COLORTERM not set, got: {:?}",
            s
        );
        assert!(
            s.contains("TT=dark"),
            "child TERM_THEME should default dark, got: {:?}",
            s
        );
        assert!(
            s.contains("CFG=15;0"),
            "child COLORFGBG should default dark, got: {:?}",
            s
        );
    }

    #[test]
    fn terminal_theme_env_dark_and_light() {
        let dark = terminal_theme_env(true);
        assert_eq!(
            dark,
            vec![
                ("TERM_THEME".into(), "dark".into()),
                ("COLORFGBG".into(), "15;0".into()),
            ]
        );
        let light = terminal_theme_env(false);
        assert_eq!(
            light,
            vec![
                ("TERM_THEME".into(), "light".into()),
                ("COLORFGBG".into(), "0;15".into()),
            ]
        );
        assert_eq!(parse_term_theme(Some("Dark")), Some(true));
        assert_eq!(parse_term_theme(Some(" light ")), Some(false));
        assert_eq!(parse_term_theme(Some("system")), None);
        assert_eq!(parse_term_theme(None), None);
    }

    #[test]
    fn terminal_theme_default_preserves_parent_hints() {
        let mut cmd = CommandBuilder::new("echo");
        cmd.env("TERM_THEME", "light");
        cmd.env("COLORFGBG", "0;15");

        apply_terminal_theme_env(&mut cmd, &[]);

        assert_eq!(
            cmd.get_env("TERM_THEME"),
            Some(std::ffi::OsStr::new("light"))
        );
        assert_eq!(cmd.get_env("COLORFGBG"), Some(std::ffi::OsStr::new("0;15")));
    }

    #[test]
    fn terminal_theme_defaults_to_dark_without_any_hint() {
        let mut cmd = CommandBuilder::new("echo");
        cmd.env_remove("TERM_THEME");
        cmd.env_remove("COLORFGBG");

        apply_terminal_theme_env(&mut cmd, &[]);

        assert_eq!(
            cmd.get_env("TERM_THEME"),
            Some(std::ffi::OsStr::new("dark"))
        );
        assert_eq!(cmd.get_env("COLORFGBG"), Some(std::ffi::OsStr::new("15;0")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn extra_env_overrides_default_terminal_theme() {
        let extra = terminal_theme_env(false);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let host = PtyHost::spawn(
            98,
            "bash",
            &[
                "-c".into(),
                "echo TT=$TERM_THEME CFG=$COLORFGBG; sleep 0.1".into(),
            ],
            portable_pty::PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            std::path::Path::new("/tmp"),
            tx,
            &extra,
        )
        .expect("spawn");

        let mut got = Vec::<u8>::new();
        let _ = timeout(Duration::from_secs(2), async {
            while let Some(act) = rx.recv().await {
                if let CoreEvent::PtyBytes { bytes, .. } = act {
                    got.extend(bytes);
                    if String::from_utf8_lossy(&got).contains("CFG=") {
                        break;
                    }
                }
            }
        })
        .await;
        drop(host);

        let s = String::from_utf8_lossy(&got);
        assert!(s.contains("TT=light"), "extra_env should win, got: {:?}", s);
        assert!(s.contains("CFG=0;15"), "extra_env should win, got: {:?}", s);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn write_then_read() {
        // bash 读一行 echo 回去
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let host = PtyHost::spawn(
            1,
            "bash",
            &["-c".into(), "read line; echo GOT:$line; sleep 0.1".into()],
            portable_pty::PtySize {
                cols: 80,
                rows: 24,
                pixel_width: 0,
                pixel_height: 0,
            },
            std::path::Path::new("/tmp"),
            tx,
            &[],
        )
        .expect("spawn");

        // 等 bash 起来再写
        tokio::time::sleep(Duration::from_millis(150)).await;
        host.write_all(b"WORLD\n").expect("write");

        let mut got = Vec::<u8>::new();
        let _ = timeout(Duration::from_secs(2), async {
            while let Some(act) = rx.recv().await {
                if let CoreEvent::PtyBytes { bytes, .. } = act {
                    got.extend(bytes);
                    if String::from_utf8_lossy(&got).contains("GOT:WORLD") {
                        break;
                    }
                }
            }
        })
        .await;
        drop(host);

        let s = String::from_utf8_lossy(&got);
        assert!(s.contains("GOT:WORLD"), "got: {:?}", s);
    }
}
