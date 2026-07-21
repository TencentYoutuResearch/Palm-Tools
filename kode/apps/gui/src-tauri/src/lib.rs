//! kode-gui — Tauri 2 后端。
//!
//! 设计要点(继承 v0.1 TUI 的"极致性能 + 零渲染"初衷):
//!
//! 1. **后端会话状态**: `AppState` 持有 `HashMap<SessionId, Session>` + 每 session 的
//!    coalesce buffer(`Vec<u8>` + interval task)。session 内部仍走 `kode_core::Session`。
//!
//! 2. **字节流走 Tauri IPC Channel**(非 emit):前端 invoke 一个命令拿到 channel,
//!    后端按 ~8ms tick 把累积的 bytes 一次性 send。`cat` 大文件时 IPC 频率 ~120/s 而非 1000+/s。
//!
//! 3. **CoreEvent 桥接**: kode-core 的 PTY/jsonl 产生 CoreEvent → 后端分发:
//!    PtyBytes 走 channel(高频),PtyExited / JsonlMeta 走低频 emit(便宜)。

mod backend_admin;
mod bridge;
mod commands;
mod deploy;
mod endpoints;
mod memory;
mod memory_mcp;
mod model_monitor;
mod model_usage;
mod persistence;
mod shell_pty;
mod specops;
mod state;
mod transport;
mod workspace;

// 集成测试入口(`tests/bridge_e2e.rs` 等)。生产代码请用 `run()` 启动。
#[doc(hidden)]
pub use crate::bridge::BridgeCtx;
#[doc(hidden)]
pub use crate::transport::{start_remote_tasks, LocalTransport, RemoteConfig, RemoteTransport};
#[doc(hidden)]
pub use kode_bridge::{build_router, build_test_ctx};

use tauri::Manager;

use std::sync::Arc;

use crate::bridge::{spawn_bridge, BridgeConfig};
use crate::state::AppState;
use kode_bridge::HookRelay;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,kode_gui=debug,kode_core=debug")
            }),
        )
        .try_init();

    // 修双击 .app 启动时 PATH 只有 launchd 最小集(`/usr/bin:/bin:...`)的问题。
    // 必须在 tauri::Builder 之前调用 —— `portable_pty::CommandBuilder` 在
    // `PtyHost::spawn` 时拿的是当前进程 env 快照,改晚了不生效。
    // 报错链路:spawn_session → PtyHost::spawn → spawn_command → "spawn child failed"
    // (子进程是 codebuddy/claude,装在 /opt/homebrew/bin / ~/.cargo/bin / ~/.local/bin
    //  这种 launchd 默认 PATH 找不到的位置)。
    let _ = fix_path_env::fix();

    // macOS 上必须关闭"长按字母弹重音字符选择器"(ApplePressAndHoldEnabled)。
    // 不关的后果:
    //   - 长按字母不会触发 keyrepeat(被 accent popup 替代)
    //   - 快速连打会丢字符(系统在前几十 ms 等"是不是要长按",按得快被吞)
    // 所有终端类应用(iTerm / Alacritty / VSCode 集成终端)都做这个。
    // 用 `defaults write` 在用户层 NSUserDefaults 写一次;Tauri / Cocoa 启动后
    // 读到 false 就不会再拦截重复键事件。
    #[cfg(target_os = "macos")]
    disable_apple_press_and_hold();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // 创建 HookRelay(Unix Domain Socket),用于接收 codebuddy/claude hook 事件。
            let hook_relay = tauri::async_runtime::block_on(HookRelay::new()).ok();
            let hook_relay_socket = hook_relay.as_ref().map(|r| r.socket_path().to_path_buf());

            let app_state = AppState::new(handle.clone(), hook_relay_socket);

            // HookRelay 需要 BridgeBus(AppState 内部创建的),所以 AppState 创建后再 spawn relay task。
            if let Some(relay) = hook_relay {
                let bus = Arc::clone(&app_state.ctx.bus);
                let core_tx = app_state.ctx.core_tx.clone();
                tauri::async_runtime::spawn(async move {
                    relay.run(bus, core_tx).await;
                });
            }
            let ctx_for_bridge = std::sync::Arc::clone(&app_state.protocol_ctx);
            app.manage(app_state);
            app.manage(shell_pty::ShellPtyManager::new());
            // Phase 9.1:启动远程桥(0.0.0.0:47870 默认)
            spawn_bridge(ctx_for_bridge, BridgeConfig::default());
            // M4:memory review queue —— 共享 ~/.kode-memory(env KODE_MEMORY_ROOT 可覆盖),
            // 与 CLI / MCP 子进程同一份数据;打不开就静默降级,GUI 仍能跑。
            if let Some(mem) = crate::memory::try_open() {
                crate::memory::spawn_pending_watcher(std::sync::Arc::clone(&mem), handle.clone());
                // Phase 10.13:每小时把 metrics.jsonl 的 recall_clicked 聚到 facts 表
                crate::memory::spawn_recall_aggregator(std::sync::Arc::clone(&mem));
                // Phase 10.17:启动时 git pull→reconcile 一次(去中心化跨机同步)
                crate::memory::spawn_sync_task(std::sync::Arc::clone(&mem));
                app.manage(mem);
            }
            // M4.1:启动后 800ms 检测 codebuddy MCP 配置;没配且未 dismiss 就 emit
            // banner 事件让前端弹横幅。stdio 模型下 kode 不主动 spawn server —
            // codebuddy 各 tab 自己 spawn,生命周期跟 tab 一致。
            crate::memory_mcp::spawn_startup_probe(handle.clone());

            // 2026-06:首次启动把 enabled==None 的 backend 按 PATH 探测落地为
            // Some(true/false)。只改 None 项,用户手改过的 Some 不动。冷快照限制下
            // 这次写盘不影响当前进程的 BackendChooser,但下次重启就只显示已安装的。
            // 失败静默降级(探测不了就保持 None = 全展示,不阻断启动)。
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                if let Err(e) = crate::backend_admin::resolve_pending_enabled(&state) {
                    tracing::warn!(error = %e, "resolve_pending_enabled failed");
                }
            }
            if let Err(error) = crate::model_monitor::create_model_monitor(&handle) {
                tracing::warn!(%error, "model monitor window unavailable");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_backends,
            commands::discover_backend_models,
            commands::list_avatar_library,
            commands::spawn_session,
            commands::write_input,
            commands::write_input_remote,
            commands::resize_session,
            commands::kill_session,
            commands::set_title,
            commands::get_screen_snapshot,
            commands::subscribe_session_bytes,
            commands::unsubscribe_session_bytes,
            commands::get_persisted_tabs,
            commands::save_tabs,
            commands::open_new_window,
            commands::focus_main_window,
            commands::open_specops_window,
            commands::specops_open,
            commands::specops_init_git_workspace,
            commands::specops_close,
            commands::get_pairing_payload,
            commands::get_paths_config,
            commands::set_session_cwd,
            commands::set_config_path,
            commands::get_home_dir,
            workspace::workspace_snapshot,
            workspace::workspace_list_dir,
            workspace::workspace_preview_file,
            workspace::workspace_git_diff,
            workspace::workspace_git_commit_diff,
            workspace::workspace_git_commit_detail,
            workspace::workspace_git_commit_file_diff,
            commands::get_theme,
            commands::set_theme,
            commands::get_locale,
            commands::set_locale,
            commands::cwd_history_get,
            commands::cwd_history_push,
            commands::memory_browse_state_get,
            commands::memory_browse_state_set,
            workspace::open_path,
            commands::read_clipboard,
            commands::list_sessions_for_cwd,
            model_usage::model_usage_snapshot,
            model_monitor::model_monitor_set_expanded,
            model_monitor::model_monitor_reposition,
            // M4 memory review queue
            memory::memory_list_pending,
            memory::memory_stats,
            memory::memory_review,
            memory::memory_read_fact,
            memory::memory_propose,
            // Phase 10.18:远端 memory 审核
            memory::memory_list_pending_remote,
            memory::memory_review_remote,
            memory::memory_search_remote,
            memory::memory_list_recent_remote,
            // M4.3(Phase 10.9-13)browse / detail / metrics
            memory::memory_search,
            memory::memory_read_with_backlinks,
            memory::memory_deprecate,
            memory::memory_update_scope,
            memory::memory_bump_recall,
            memory::memory_metrics_summary,
            memory::memory_list_recent,
            memory::memory_list_scopes,
            memory::memory_sync_config,
            memory::memory_sync_config_set,
            memory::memory_sync_now,
            // M4.1 memory MCP setup
            memory_mcp::memory_mcp_check,
            memory_mcp::memory_mcp_setup_codebuddy,
            memory_mcp::memory_mcp_setup_claude_internal,
            memory_mcp::memory_mcp_setup_backend,
            memory_mcp::memory_mcp_dismiss_prompt,
            // M4.2 kode-memory prompt 注入开关
            memory_mcp::memory_prompt_status,
            memory_mcp::memory_prompt_set_enabled,
            // 2026-06 backend 数据驱动管理
            backend_admin::detect_known_backends,
            backend_admin::backend_save,
            backend_admin::backend_delete,
            backend_admin::backend_set_enabled,
            commands::list_all_backends,
            // Phase 11.4 远端 endpoint 配置
            endpoints::endpoint_list,
            endpoints::endpoint_add,
            endpoints::endpoint_remove,
            endpoints::endpoint_update_display_name,
            endpoints::endpoint_test_connection,
            // Phase 11.5 BackendChooser 拉远端 backends + 远端 cwd 浏览
            endpoints::endpoint_get_remote_backends,
            endpoints::endpoint_discover_backend_models,
            endpoints::endpoint_fs_list,
            endpoints::endpoint_list_sessions_for_cwd,
            // 远端 tab WorkspacePanel(Files + Git)支持
            endpoints::endpoint_workspace_snapshot,
            endpoints::endpoint_workspace_list_dir,
            endpoints::endpoint_workspace_preview_file,
            endpoints::endpoint_workspace_git_diff,
            endpoints::endpoint_workspace_git_commit_diff,
            endpoints::endpoint_workspace_git_commit_detail,
            endpoints::endpoint_workspace_git_commit_file_diff,
            // 远端 Bridge 部署安装(SSH 推 tarball + 停旧 + 起新 + 取 token)
            deploy::deploy_remote_bridge,
            // Shell PTY(工作区终端面板)
            shell_pty::spawn_shell,
            shell_pty::write_shell,
            shell_pty::resize_shell,
            shell_pty::kill_shell,
            shell_pty::subscribe_shell_bytes,
            shell_pty::unsubscribe_shell_bytes,
            shell_pty::get_shell_snapshot,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // app 退出时主动停掉所有 SpecOps sidecar 子进程,避免变成孤儿残留。
            // RunEvent::Exit 在主事件循环结束、进程真正退出前触发,比依赖
            // SpecOpsManager 的 Drop 更可靠(macOS GUI 直接 exit 时 Drop 不保证跑)。
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                state.specops.shutdown_all();
            }
        });
}

/// 关闭 macOS 长按字母重音菜单(press-and-hold accent popup)。
///
/// 不关的后果:
///   - 长按字母不会触发 keyrepeat(被 accent popup 替代)
///   - 快速连打前 ~150ms 内字符会被吞(系统在等"是不是要长按")
/// 所有终端类应用(iTerm/Alacritty/VSCode 集成终端)都做这件事。
///
/// 用 `setBool:forKey:` 写到当前 bundle 的 ApplicationDomain(NSUserDefaults
/// 查找顺序第 2 层),压住 NSGlobalDomain 的默认 YES。等价于命令行
/// `defaults write <bundle-id> ApplePressAndHoldEnabled -bool false`,但直接
/// 写进当前进程的 NSUserDefaults 缓存,无需重启,与 bundle id 无关。
///
/// **必须在 Tauri Builder 创建之前调用** —— NSWindow 建好后再改,首批按键
/// 已经走过老缓存,不生效。
///
/// 已知局限:WKWebView 的 WebContent 子进程是独立 bundle(`com.apple.WebKit.WebContent`),
/// 有自己的 NSUserDefaults 缓存,主进程写不进去。但终端区域的 keystroke
/// 大部分时序仍受主进程 NSResponder 链影响,这条修复对绝大多数场景仍生效。
/// 极端边缘场景(如某些第三方中文输入法的 IME 状态机)可能仍有 keyrepeat 问题,
/// 但那是输入法兼容性,不在这个修复范围内。
#[cfg(target_os = "macos")]
fn disable_apple_press_and_hold() {
    use objc2_foundation::{NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("ApplePressAndHoldEnabled");
    defaults.setBool_forKey(false, &key);
}
