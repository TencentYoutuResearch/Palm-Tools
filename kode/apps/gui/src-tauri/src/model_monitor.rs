//! 系统级 model token 刘海窗口。
//!
//! 在带刘海的 MacBook 屏幕上，前端会读取这里返回的 `NSScreen` 安全区和辅助
//! 顶部区域，把真实硬件刘海作为组件中央，信息只画在左右菜单栏安全区。外接
//! 无刘海屏使用同一套连续轮廓和标准 185pt 模拟刘海，避免维护第二套交互。
//!
//! 收起时透明窗口保持稳定几何但开启鼠标穿透，原生光标巡检只命中顶部刘海区；
//! 展开后才恢复 WebView 交互，并按面板真实高度从屏幕顶边向下收紧。macOS 额外
//! 提升到 status-window 层，并允许出现在所有 Space / 全屏桌面中。

use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MODEL_MONITOR_LABEL_PREFIX: &str = "kode-model-monitor-";
const MODEL_MONITOR_LAYOUT_EVENT: &str = "model-monitor-layout-changed";
const MODEL_MONITOR_NATIVE_HOVER_EVENT: &str = "model-monitor-native-hover-changed";
static EXPANDED_MODEL_MONITORS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
const COLLAPSED_WIDTH: f64 = 440.0;
const COLLAPSED_HOVER_WIDTH: f64 = 400.0;
const COLLAPSED_HOVER_HEIGHT: f64 = 36.0;
const SIMULATED_NOTCH_WIDTH: f64 = 185.0;
const EXPANDED_WIDTH: f64 = 660.0;
// 展开动画先使用足够大的画布，稳定后由前端按真实内容高度调用
// `model_monitor_fit_height` 收紧，避免透明窗口继续拦截面板下方点击。
const EXPANDED_HEIGHT: f64 = 720.0;
const EXPANDED_MIN_HEIGHT: f64 = 120.0;
#[cfg(target_os = "macos")]
const FULLSCREEN_REFRESH_DELAYS_MS: [u64; 2] = [180, 720];

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMonitorLayout {
    is_notched: bool,
    notch_width: f64,
    notch_height: f64,
    menu_bar_height: f64,
}

impl ModelMonitorLayout {
    fn fallback(monitor: &tauri::Monitor) -> Self {
        let top_inset = (monitor.work_area().position.y - monitor.position().y).max(0) as f64
            / monitor.scale_factor();
        Self {
            is_notched: false,
            notch_width: SIMULATED_NOTCH_WIDTH,
            notch_height: top_inset.clamp(24.0, 32.0),
            menu_bar_height: top_inset.max(24.0),
        }
    }

    fn collapsed_height(self) -> f64 {
        self.notch_height.ceil()
    }
}

pub fn create_model_monitor(app: &tauri::AppHandle) -> Result<(), String> {
    sync_model_monitor_windows(app)?;
    install_model_monitor_main_window_listener(app);
    start_model_monitor_display_sync(app);
    Ok(())
}

fn create_model_monitor_for_display(
    app: &tauri::AppHandle,
    monitor: &tauri::Monitor,
) -> Result<WebviewWindow, String> {
    let label = model_monitor_label(monitor);
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("index.html?model_monitor=1".into()),
    )
    .title("")
    .inner_size(EXPANDED_WIDTH, EXPANDED_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .build()
    .map_err(|error| format!("create model monitor window failed: {error}"))?;

    set_model_monitor_expanded(&window, false);
    position_model_monitor_on_display(&window, monitor, true)?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("enable collapsed model monitor click-through failed: {error}"))?;
    configure_macos_status_window(&window)?;
    start_model_monitor_hover_tracking(&window);
    Ok(window)
}

fn install_model_monitor_main_window_listener(app: &tauri::AppHandle) {
    // model monitor 是主窗口的系统级伴随窗口，不应改变原有“关闭主窗口即退出”语义。
    if let Some(main) = app.get_webview_window("main") {
        let app = app.clone();
        let refresh_generation = Arc::new(AtomicU64::new(0));
        main.on_window_event(move |event| match event {
            tauri::WindowEvent::Destroyed => {
                refresh_generation.fetch_add(1, Ordering::AcqRel);
                for window in model_monitor_windows(&app) {
                    set_model_monitor_expanded(&window, false);
                    let _ = window.close();
                }
            }
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. }
            | tauri::WindowEvent::Focused(_) => {
                if let Err(error) = refresh_model_monitor_parenting(&app) {
                    tracing::warn!(%error, "refresh model monitor fullscreen attachment failed");
                }
                schedule_model_monitors_post_transition_refresh(&app, refresh_generation.clone());
            }
            _ => {}
        });
    }
}

fn start_model_monitor_display_sync(app: &tauri::AppHandle) {
    let app = app.clone();
    let known_labels = Arc::new(Mutex::new(
        available_model_monitor_labels(&app).unwrap_or_default(),
    ));
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(1200));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if app.get_webview_window("main").is_none() {
                break;
            }
            let app_for_sync = app.clone();
            let known_labels = known_labels.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let Ok(next_labels) = available_model_monitor_labels(&app_for_sync) else {
                    return;
                };
                let changed = known_labels
                    .lock()
                    .ok()
                    .is_some_and(|known| *known != next_labels);
                if !changed {
                    return;
                }
                match sync_model_monitor_windows(&app_for_sync) {
                    Ok(()) => {
                        if let Ok(mut known) = known_labels.lock() {
                            *known = next_labels;
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "sync model monitor windows failed");
                    }
                }
            }) {
                tracing::warn!(%error, "schedule model monitor display sync failed");
                break;
            }
        }
    });
}

fn available_model_monitor_labels(app: &tauri::AppHandle) -> Result<HashSet<String>, tauri::Error> {
    Ok(app
        .available_monitors()?
        .iter()
        .map(model_monitor_label)
        .collect())
}

#[tauri::command]
pub fn model_monitor_set_expanded(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    if !is_model_monitor_window(&window) {
        return Err("model monitor resize is only available to its own window".into());
    }
    if expanded {
        window.set_ignore_cursor_events(false).map_err(|error| {
            format!("enable expanded model monitor interaction failed: {error}")
        })?;
        set_model_monitor_expanded(&window, true);
        return Ok(());
    }
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("enable collapsed model monitor click-through failed: {error}"))?;
    set_model_monitor_expanded(&window, false);
    Ok(())
}

/// 展开动画完成后，让透明原生窗口贴合可见面板高度。前端可能在关闭过程中仍有
/// ResizeObserver 回调排队，因此这里只接受当前仍处于展开宽度的窗口。
#[tauri::command]
pub fn model_monitor_fit_height(window: WebviewWindow, height: f64) -> Result<(), String> {
    if !is_model_monitor_window(&window) {
        return Err("model monitor resize is only available to its own window".into());
    }
    if !height.is_finite() {
        return Err("model monitor height must be finite".into());
    }
    if !is_model_monitor_expanded(&window) {
        return Ok(());
    }
    let Some(monitor) = target_monitor(&window) else {
        return Ok(());
    };
    let size = window
        .inner_size()
        .map_err(|error| format!("read model monitor size before fit failed: {error}"))?;
    let logical_width = size.width as f64 / monitor.scale_factor();
    if !is_expanded_width(logical_width) {
        return Ok(());
    }
    let fitted_height = fitted_expanded_height(height);
    let logical_height = size.height as f64 / monitor.scale_factor();
    if (logical_height - fitted_height).abs() < 1.0 {
        return Ok(());
    }
    resize_model_monitor_from_top(&window, EXPANDED_WIDTH, fitted_height)
}

#[cfg(target_os = "macos")]
fn resize_model_monitor_from_top(
    window: &WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let raw = window
        .ns_window()
        .map_err(|error| format!("get model monitor NSWindow before fit failed: {error}"))?;
    // SAFETY: Tauri owns the NSWindow. The synchronous command runs on AppKit's UI
    // thread; setFrame updates origin and size in one transaction so the top edge
    // never drifts while the transparent surface is fitted to its content.
    let ns_window: &NSWindow = unsafe { &*raw.cast() };
    let current = ns_window.frame();
    let center_x = current.origin.x + current.size.width / 2.0;
    let top = current.origin.y + current.size.height;
    ns_window.setFrame_display(
        NSRect::new(
            NSPoint::new(center_x - width / 2.0, top - height),
            NSSize::new(width, height),
        ),
        true,
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn resize_model_monitor_from_top(
    window: &WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| format!("fit model monitor to panel height failed: {error}"))
}

fn fitted_expanded_height(height: f64) -> f64 {
    height.clamp(EXPANDED_MIN_HEIGHT, EXPANDED_HEIGHT)
}

fn is_expanded_width(width: f64) -> bool {
    (width - EXPANDED_WIDTH).abs() < 1.0
}

fn is_collapsed_width(width: f64) -> bool {
    (width - COLLAPSED_WIDTH).abs() < 1.0
}

/// 显示器排列/主屏变化后重新定位并返回目标屏幕的刘海几何。只有收起态跨越
/// 不同刘海/菜单栏高度时才校正高度，日常巡检不会反复 resize。
#[tauri::command]
pub fn model_monitor_reposition(window: WebviewWindow) -> Result<ModelMonitorLayout, String> {
    if !is_model_monitor_window(&window) {
        return Err("model monitor reposition is only available to its own window".into());
    }
    reposition_model_monitor(&window)
}

fn reposition_model_monitor(window: &WebviewWindow) -> Result<ModelMonitorLayout, String> {
    let monitor = target_monitor(window);
    let Some(monitor) = monitor else {
        return Ok(ModelMonitorLayout {
            is_notched: false,
            notch_width: SIMULATED_NOTCH_WIDTH,
            notch_height: 24.0,
            menu_bar_height: 24.0,
        });
    };
    let size = window
        .inner_size()
        .map_err(|error| format!("read model monitor size failed: {error}"))?;
    let x = monitor.position().x + ((monitor.size().width as i32 - size.width as i32) / 2).max(0);
    let y = monitor.position().y;
    let current_position = window
        .outer_position()
        .map_err(|error| format!("read model monitor position failed: {error}"))?;
    if current_position.x != x || current_position.y != y {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| format!("reposition model monitor failed: {error}"))?;
    }
    // NSWindow.screen must be read after moving: otherwise the first poll after a
    // cross-display move returns the old display's notch geometry.
    let layout = model_monitor_layout(&window, &monitor);
    let size = window
        .inner_size()
        .map_err(|error| format!("read model monitor size on target screen failed: {error}"))?;
    let logical_width = size.width as f64 / monitor.scale_factor();
    let logical_height = size.height as f64 / monitor.scale_factor();
    let collapsed_height = layout.collapsed_height();
    if is_collapsed_width(logical_width) && (logical_height - collapsed_height).abs() >= 1.0 {
        window
            .set_size(tauri::LogicalSize::new(COLLAPSED_WIDTH, collapsed_height))
            .map_err(|error| format!("resize model monitor for target screen failed: {error}"))?;
    }
    Ok(layout)
}

fn sync_model_monitor_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("list displays for model monitors failed: {error}"))?;
    let desired_labels: HashSet<String> = monitors.iter().map(model_monitor_label).collect();

    for window in model_monitor_windows(app) {
        if !desired_labels.contains(window.label()) {
            set_model_monitor_expanded(&window, false);
            window
                .close()
                .map_err(|error| format!("close detached model monitor failed: {error}"))?;
        }
    }

    for monitor in monitors {
        let label = model_monitor_label(&monitor);
        let window = if let Some(window) = app.get_webview_window(&label) {
            window
        } else {
            create_model_monitor_for_display(app, &monitor)?
        };
        let layout = position_model_monitor_on_display(&window, &monitor, false)?;
        #[cfg(target_os = "macos")]
        {
            attach_model_monitor_to_main_display(app, &window, &monitor)?;
            reassert_macos_status_window(&window)?;
        }
        let _ = window.emit_to(
            tauri::EventTarget::webview_window(window.label()),
            MODEL_MONITOR_LAYOUT_EVENT,
            layout,
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn refresh_model_monitor_parenting(app: &tauri::AppHandle) -> Result<(), String> {
    for window in model_monitor_windows(app) {
        let Some(monitor) = target_monitor(&window) else {
            continue;
        };
        attach_model_monitor_to_main_display(app, &window, &monitor)?;
        reassert_macos_status_window(&window)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn refresh_model_monitor_parenting(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

fn model_monitor_windows(app: &tauri::AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(is_model_monitor_window)
        .collect()
}

fn is_model_monitor_window(window: &WebviewWindow) -> bool {
    window.label().starts_with(MODEL_MONITOR_LABEL_PREFIX)
}

fn model_monitor_label(monitor: &tauri::Monitor) -> String {
    model_monitor_label_for_signature(monitor_signature(monitor))
}

fn model_monitor_label_for_signature(
    (x, y, width, height, scale): (i32, i32, u32, u32, u64),
) -> String {
    format!("{MODEL_MONITOR_LABEL_PREFIX}x{x}-y{y}-w{width}-h{height}-s{scale:016x}")
}

fn set_model_monitor_expanded(window: &WebviewWindow, expanded: bool) {
    let Ok(mut expanded_windows) = EXPANDED_MODEL_MONITORS.lock() else {
        return;
    };
    if expanded {
        expanded_windows.insert(window.label().to_string());
    } else {
        expanded_windows.remove(window.label());
    }
}

fn is_model_monitor_expanded(window: &WebviewWindow) -> bool {
    EXPANDED_MODEL_MONITORS
        .lock()
        .ok()
        .is_some_and(|expanded| expanded.contains(window.label()))
}

/// macOS sends resize/focus changes while the fullscreen animation is still moving
/// the window into its new Space. An immediate `orderFrontRegardless` can therefore
/// be undone by AppKit a moment later. Re-run the refresh after the event stream
/// settles, always hopping back to the AppKit main thread before touching NSWindow.
#[cfg(target_os = "macos")]
fn schedule_model_monitors_post_transition_refresh(
    app: &tauri::AppHandle,
    refresh_generation: Arc<AtomicU64>,
) {
    let generation = refresh_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut elapsed_ms = 0;
        for delay_ms in FULLSCREEN_REFRESH_DELAYS_MS {
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms - elapsed_ms)).await;
            elapsed_ms = delay_ms;
            if refresh_generation.load(Ordering::Acquire) != generation {
                break;
            }

            let app_for_refresh = app.clone();
            let refresh_generation = refresh_generation.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if refresh_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                if let Err(error) = sync_model_monitor_windows(&app_for_refresh) {
                    tracing::warn!(
                        %error,
                        "refresh model monitors after fullscreen transition failed"
                    );
                }
            }) {
                tracing::warn!(%error, "schedule model monitor fullscreen refresh failed");
                break;
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn schedule_model_monitors_post_transition_refresh(
    _app: &tauri::AppHandle,
    _refresh_generation: Arc<AtomicU64>,
) {
}

fn position_model_monitor_on_display(
    window: &WebviewWindow,
    monitor: &tauri::Monitor,
    initialize_size: bool,
) -> Result<ModelMonitorLayout, String> {
    if initialize_size {
        window
            .set_size(tauri::LogicalSize::new(EXPANDED_WIDTH, EXPANDED_HEIGHT))
            .map_err(|error| format!("resize model monitor failed: {error}"))?;
    }

    let size = window
        .inner_size()
        .map_err(|error| format!("read model monitor size before positioning failed: {error}"))?;
    let x = monitor.position().x + ((monitor.size().width as i32 - size.width as i32) / 2).max(0);
    let y = monitor.position().y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("position model monitor failed: {error}"))?;
    let layout = model_monitor_layout(window, monitor);
    let logical_width = size.width as f64 / monitor.scale_factor();
    let logical_height = size.height as f64 / monitor.scale_factor();
    if !is_model_monitor_expanded(window) && is_collapsed_width(logical_width) {
        let collapsed_height = layout.collapsed_height();
        if (collapsed_height - logical_height).abs() >= 1.0 {
            window
                .set_size(tauri::LogicalSize::new(COLLAPSED_WIDTH, collapsed_height))
                .map_err(|error| format!("resize model monitor for notch failed: {error}"))?;
        }
    }
    Ok(layout)
}

fn model_monitor_layout(window: &WebviewWindow, monitor: &tauri::Monitor) -> ModelMonitorLayout {
    platform_model_monitor_layout(window).unwrap_or_else(|| ModelMonitorLayout::fallback(monitor))
}

#[cfg(target_os = "macos")]
fn platform_model_monitor_layout(window: &WebviewWindow) -> Option<ModelMonitorLayout> {
    use objc2_app_kit::NSWindow;

    // Each display owns its own overlay. Reading the main window's NSScreen here
    // would give every overlay the geometry of whichever display contains `main`.
    let raw = window.ns_window().ok()?;
    // SAFETY: Tauri owns the NSWindow. This runs on the AppKit main thread and only
    // reads its current NSScreen geometry.
    let ns_window: &NSWindow = unsafe { &*raw.cast() };
    let screen = ns_window.screen()?;
    let frame = screen.frame();
    let visible = screen.visibleFrame();
    let safe = screen.safeAreaInsets();
    let left = screen.auxiliaryTopLeftArea();
    let right = screen.auxiliaryTopRightArea();
    let menu_bar_height =
        ((frame.origin.y + frame.size.height) - (visible.origin.y + visible.size.height)).max(24.0);
    // NSScreen's auxiliary rectangles are the usable strips to the left and right
    // of the camera housing. Their origins are not reliable across mixed display
    // arrangements; subtract their widths from the full screen instead. The small
    // overlap hides antialiasing seams at the two physical notch shoulders.
    let notch_width = (frame.size.width - left.size.width - right.size.width + 4.0).max(0.0);
    let is_notched = safe.top > 0.5 && notch_width > 1.0;

    Some(ModelMonitorLayout {
        is_notched,
        notch_width: if is_notched {
            notch_width
        } else {
            SIMULATED_NOTCH_WIDTH
        },
        notch_height: if is_notched {
            safe.top
        } else {
            menu_bar_height.clamp(24.0, 32.0)
        },
        menu_bar_height,
    })
}

#[cfg(not(target_os = "macos"))]
fn platform_model_monitor_layout(_window: &WebviewWindow) -> Option<ModelMonitorLayout> {
    None
}

fn target_monitor(window: &WebviewWindow) -> Option<tauri::Monitor> {
    // Window labels are derived from display geometry, so an overlay remains bound
    // to its own display even when the main window enters fullscreen elsewhere.
    window
        .app_handle()
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors
                .into_iter()
                .find(|monitor| model_monitor_label(monitor) == window.label())
        })
        .or_else(|| window.current_monitor().ok().flatten())
}

fn monitor_signature(monitor: &tauri::Monitor) -> (i32, i32, u32, u32, u64) {
    (
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        monitor.scale_factor().to_bits(),
    )
}

/// WKWebView 的 DOM tracking area 在窗口所属 app 非激活时不会稳定发送 mouseenter。
/// 用系统光标坐标做低频兜底，不激活 kode，也不申请全局输入监听权限。
#[cfg(target_os = "macos")]
fn start_model_monitor_hover_tracking(window: &WebviewWindow) {
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(80));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut hovered = false;
        let mut hover_heartbeat = 0_u8;
        loop {
            timer.tick().await;
            if window
                .app_handle()
                .get_webview_window(window.label())
                .is_none()
            {
                break;
            }
            let expanded = is_model_monitor_expanded(&window);
            let next = window
                .cursor_position()
                .ok()
                .zip(window.outer_position().ok())
                .zip(window.outer_size().ok())
                .is_some_and(|((cursor, position), size)| {
                    point_is_inside_monitor_hit_region(
                        cursor.x,
                        cursor.y,
                        position.x,
                        position.y,
                        size.width,
                        size.height,
                        window.scale_factor().unwrap_or(1.0),
                        expanded,
                    )
                });

            // hover 时每 400ms 重发一次，避免页面 listener 尚未注册时丢掉唯一一次
            // enter；离开只发状态边沿，避免持续 IPC。
            hover_heartbeat = if next {
                hover_heartbeat.saturating_add(1)
            } else {
                0
            };
            if next != hovered || (next && hover_heartbeat >= 5) {
                let _ = window.emit_to(
                    tauri::EventTarget::webview_window(window.label()),
                    MODEL_MONITOR_NATIVE_HOVER_EVENT,
                    next,
                );
                hover_heartbeat = 0;
            }
            hovered = next;
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn start_model_monitor_hover_tracking(_window: &WebviewWindow) {}

fn point_is_inside_monitor_hit_region(
    cursor_x: f64,
    cursor_y: f64,
    window_x: i32,
    window_y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    expanded: bool,
) -> bool {
    let (hit_x, hit_width, hit_height) = if expanded {
        (window_x as f64, width as f64, height as f64)
    } else {
        let hit_width = (COLLAPSED_HOVER_WIDTH * scale_factor).min(width as f64);
        (
            window_x as f64 + (width as f64 - hit_width) / 2.0,
            hit_width,
            (COLLAPSED_HOVER_HEIGHT * scale_factor).min(height as f64),
        )
    };
    cursor_x >= hit_x
        && cursor_x < hit_x + hit_width
        && cursor_y >= window_y as f64
        && cursor_y < window_y as f64 + hit_height
}

#[cfg(target_os = "macos")]
fn configure_macos_status_window(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSStatusWindowLevel, NSWindow};

    let raw = window
        .ns_window()
        .map_err(|error| format!("get model monitor NSWindow failed: {error}"))?;
    // SAFETY: Tauri owns `raw` for at least as long as `window`; setup runs on the
    // AppKit main thread and we only mutate documented NSWindow presentation flags.
    let ns_window: &NSWindow = unsafe { &*raw.cast() };
    ns_window.setLevel(NSStatusWindowLevel);
    // This is a system overlay, not a document window. Keep it visible when kode is
    // inactive/hidden and explicitly order it above fullscreen apps without making it
    // key. CanJoinAllApplications is the AppKit behavior intended for floating system
    // overlays that must participate in other apps' fullscreen Spaces.
    ns_window.setHidesOnDeactivate(false);
    ns_window.setCanHide(false);
    // status-level window 默认不激活；显式接收 mouse-moved，才能像系统状态项一样
    // 在不抢走当前 app 键盘焦点的前提下响应 hover。
    ns_window.setAcceptsMouseMovedEvents(true);
    ns_window.setCollectionBehavior(model_monitor_collection_behavior());
    ns_window.orderFrontRegardless();
    Ok(())
}

#[cfg(target_os = "macos")]
fn attach_model_monitor_to_main_display(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    monitor: &tauri::Monitor,
) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};

    let Some(main) = app.get_webview_window("main") else {
        return Ok(());
    };
    let should_attach = main.is_fullscreen().unwrap_or(false)
        && main
            .current_monitor()
            .ok()
            .flatten()
            .is_some_and(|main_monitor| {
                monitor_signature(&main_monitor) == monitor_signature(monitor)
            });
    let main_raw = main.ns_window().map_err(|error| {
        format!("get main NSWindow for model monitor attachment failed: {error}")
    })?;
    let monitor_raw = window.ns_window().map_err(|error| {
        format!("get model monitor NSWindow for fullscreen attachment failed: {error}")
    })?;
    // SAFETY: Both pointers are Tauri-owned NSWindows and this function is called
    // only from AppKit's main thread. A child relationship is what makes an
    // FullScreenAuxiliary window enter the same fullscreen Space as its main window.
    let main_window: &NSWindow = unsafe { &*main_raw.cast() };
    let monitor_window: &NSWindow = unsafe { &*monitor_raw.cast() };
    let current_parent = monitor_window.parentWindow();

    if should_attach {
        if current_parent
            .as_deref()
            .is_some_and(|parent| std::ptr::eq(parent, main_window))
        {
            return Ok(());
        }
        if let Some(parent) = current_parent {
            parent.removeChildWindow(monitor_window);
        }
        unsafe {
            main_window.addChildWindow_ordered(monitor_window, NSWindowOrderingMode::Above);
        }
    } else if let Some(parent) = current_parent {
        parent.removeChildWindow(monitor_window);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn reassert_macos_status_window(window: &WebviewWindow) -> Result<(), String> {
    // AppKit may rebuild ordering and Space membership during fullscreen
    // transitions. Reapply the complete status-window contract, not only z-order.
    configure_macos_status_window(window)
}

#[cfg(target_os = "macos")]
fn model_monitor_collection_behavior() -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior;

    NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::CanJoinAllApplications
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle
}

#[cfg(not(target_os = "macos"))]
fn configure_macos_status_window(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expanded_window_is_larger_than_collapsed_hit_area() {
        assert!(EXPANDED_WIDTH > COLLAPSED_WIDTH);
        assert!(EXPANDED_HEIGHT > COLLAPSED_HOVER_HEIGHT);
        assert!(COLLAPSED_HOVER_HEIGHT <= 36.0);
    }

    #[test]
    fn fitted_height_tracks_content_without_exceeding_staging_canvas() {
        assert_eq!(fitted_expanded_height(486.0), 486.0);
        assert_eq!(fitted_expanded_height(40.0), EXPANDED_MIN_HEIGHT);
        assert_eq!(fitted_expanded_height(900.0), EXPANDED_HEIGHT);
    }

    #[test]
    fn stale_fit_requests_cannot_resize_a_collapsed_window() {
        assert!(is_expanded_width(EXPANDED_WIDTH));
        assert!(!is_expanded_width(COLLAPSED_WIDTH));
    }

    #[test]
    fn native_hover_hit_test_uses_full_expanded_window() {
        assert!(point_is_inside_monitor_hit_region(
            150.0, 20.0, 100, 10, 200, 40, 1.0, true,
        ));
        assert!(!point_is_inside_monitor_hit_region(
            300.0, 20.0, 100, 10, 200, 40, 1.0, true,
        ));
    }

    #[test]
    fn collapsed_native_hover_only_uses_centered_top_region() {
        assert!(point_is_inside_monitor_hit_region(
            330.0, 20.0, 100, 10, 460, 600, 1.0, false,
        ));
        assert!(!point_is_inside_monitor_hit_region(
            110.0, 20.0, 100, 10, 460, 600, 1.0, false,
        ));
        assert!(!point_is_inside_monitor_hit_region(
            330.0, 60.0, 100, 10, 460, 600, 1.0, false,
        ));
    }

    #[test]
    fn collapsed_window_can_cover_a_tall_notched_menu_bar() {
        let layout = ModelMonitorLayout {
            is_notched: true,
            notch_width: 185.0,
            notch_height: 32.0,
            menu_bar_height: 38.0,
        };
        assert_eq!(layout.collapsed_height(), 32.0);
    }

    #[test]
    fn simulated_notch_uses_its_own_height_on_plain_displays() {
        let layout = ModelMonitorLayout {
            is_notched: false,
            notch_width: SIMULATED_NOTCH_WIDTH,
            notch_height: 24.0,
            menu_bar_height: 24.0,
        };
        assert_eq!(layout.collapsed_height(), 24.0);
    }

    #[test]
    fn collapsed_and_expanded_widths_are_distinct() {
        assert!(is_collapsed_width(COLLAPSED_WIDTH));
        assert!(!is_collapsed_width(EXPANDED_WIDTH));
        assert!(is_expanded_width(EXPANDED_WIDTH));
        assert!(!is_expanded_width(COLLAPSED_WIDTH));
    }

    #[test]
    fn each_display_signature_gets_a_distinct_window_label() {
        let internal = model_monitor_label_for_signature((0, 0, 3024, 1964, 2.0_f64.to_bits()));
        let external = model_monitor_label_for_signature((3024, 0, 3840, 2160, 1.0_f64.to_bits()));

        assert!(internal.starts_with(MODEL_MONITOR_LABEL_PREFIX));
        assert!(external.starts_with(MODEL_MONITOR_LABEL_PREFIX));
        assert_ne!(internal, external);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn status_window_can_join_other_apps_fullscreen_spaces() {
        use objc2_app_kit::NSWindowCollectionBehavior;

        let behavior = model_monitor_collection_behavior();
        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllApplications));
        assert!(behavior.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(!behavior.intersects(
            NSWindowCollectionBehavior::Primary | NSWindowCollectionBehavior::Auxiliary
        ));
    }
}
