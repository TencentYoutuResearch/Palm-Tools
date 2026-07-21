//! kode-tui — 控制台多 Tab AI 会话管理器 TUI(v0.1 冻结版)。
//! 把 codebuddy / claude code 当作"会话后端",每个 tab = 一个 PTY 子进程。
//! 所有 UI 无关的逻辑(PTY/session/config)在 `kode-core` crate 里。

mod action;
mod app;
mod input;
mod keymap;
mod ui;

use std::io::{self, Write};
use std::panic;

use anyhow::Result;
use clap::Parser;
use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
};
use crossterm::execute;
use crossterm::style::ResetColor;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::app::App;
use kode_core::config::Config;

#[derive(Debug, Parser)]
#[command(name = "kode", version, about = "Multi-tab AI session manager TUI")]
struct Cli {
    /// 指定后端 key(覆盖配置文件 default_backend)
    #[arg(long)]
    backend: Option<String>,

    /// 启用调试日志,输出到 ~/.cache/kode/kode.log
    #[arg(long)]
    debug: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let _guard = init_logging(cli.debug);

    let mut config = Config::load();
    if let Some(b) = cli.backend {
        config.default_backend = b;
    }

    // 注册 panic hook:确保任何 panic 都能恢复终端
    install_panic_hook();

    enter_terminal()?;
    let result = run_app(config);
    leave_terminal()?;
    result
}

fn run_app(config: Config) -> Result<()> {
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let app = App::new(config);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(app.run(&mut terminal))
}

fn enter_terminal() -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    // 注意:不进入 alt-screen!子 TUI 自己会用 alt-screen,嵌套会出问题
    execute!(stdout, EnableMouseCapture, EnableBracketedPaste, Hide)?;
    Ok(())
}

fn leave_terminal() -> Result<()> {
    let mut stdout = io::stdout();
    execute!(
        stdout,
        DisableBracketedPaste,
        DisableMouseCapture,
        Show,
        ResetColor
    )?;
    disable_raw_mode()?;
    stdout.flush().ok();
    Ok(())
}

fn install_panic_hook() {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = leave_terminal();
        // 子 TUI 可能改了 alt-screen,补一个返回主屏的序列
        let _ = execute!(io::stdout(), crossterm::terminal::LeaveAlternateScreen);
        prev(info);
    }));
}

fn init_logging(debug: bool) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    if !debug {
        // 静默,但保留 RUST_LOG 配置能力
        if let Ok(filter) = tracing_subscriber::EnvFilter::try_from_default_env() {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(io::stderr)
                .try_init();
        }
        return None;
    }
    let dir = dirs::cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("kode");
    let _ = std::fs::create_dir_all(&dir);
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("kode.log"))
    {
        Ok(f) => f,
        Err(_) => return None,
    };
    let (nb, guard) = tracing_appender::non_blocking(file);
    let _ = tracing_subscriber::fmt()
        .with_writer(nb)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,kode=debug")),
        )
        .try_init();
    Some(guard)
}
