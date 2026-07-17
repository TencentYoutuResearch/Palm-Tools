//! 系统级 model token 灵动岛窗口。
//!
//! 收起时只保留顶部居中的小窗口，避免透明大窗口拦截桌面点击；展开时由前端
//! invoke 调整为完整面板尺寸。macOS 额外提升到 status-window 层，并允许出现在
//! 所有 Space / 全屏桌面中，效果不依附 kode 主窗口 titlebar。

use tauri::{Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MODEL_MONITOR_LABEL: &str = "kode-model-monitor";
// macOS 菜单栏通常约 24 logical px。内容保持 24px，窗口额外留出透明
// gutter，避免圆角抗锯齿被 WebView 边界裁切。
const COLLAPSED_WIDTH: f64 = 440.0;
const COLLAPSED_HEIGHT: f64 = 34.0;
const EXPANDED_WIDTH: f64 = 660.0;
// 面板内容约 650 logical px；只为边缘留少量透明余量，避免底部出现一大片
// 空的阴影区域，也减少透明窗口拦截桌面点击的范围。
const EXPANDED_HEIGHT: f64 = 720.0;
const TOP_GUTTER: f64 = 4.0;

pub fn create_model_monitor(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(MODEL_MONITOR_LABEL).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        MODEL_MONITOR_LABEL,
        WebviewUrl::App("index.html?model_monitor=1".into()),
    )
    .title("")
    .inner_size(COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
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

    position_model_monitor(&window, false)?;
    configure_macos_status_window(&window)?;

    // model monitor 是主窗口的系统级伴随窗口，不应改变原有“关闭主窗口即退出”语义。
    if let Some(main) = app.get_webview_window("main") {
        let monitor = window.clone();
        main.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = monitor.close();
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn model_monitor_set_expanded(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    if window.label() != MODEL_MONITOR_LABEL {
        return Err("model monitor resize is only available to its own window".into());
    }
    if expanded {
        return position_model_monitor(&window, true);
    }

    // WKWebView 在原生窗口从 expanded 尺寸缩回 collapsed 尺寸时，会先把旧画布
    // 整体等比压缩一帧，形成“灵动岛突然缩小”的闪帧。收缩 CSS 动画已经完成后，
    // 用一次不可见的 resize 换掉旧画布，再显示新尺寸，视觉上只保留 CSS 的果冻收缩。
    window
        .hide()
        .map_err(|error| format!("hide model monitor before resize failed: {error}"))?;
    let resized = position_model_monitor(&window, false);
    let shown = window
        .show()
        .map_err(|error| format!("show model monitor after resize failed: {error}"));
    resized.and(shown)
}

/// 显示器排列/主屏变化后只重新定位，不触碰当前窗口尺寸，避免巡检造成 resize 闪烁。
#[tauri::command]
pub fn model_monitor_reposition(window: WebviewWindow) -> Result<(), String> {
    if window.label() != MODEL_MONITOR_LABEL {
        return Err("model monitor reposition is only available to its own window".into());
    }
    let monitor = target_monitor(&window);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let width = window
        .inner_size()
        .map_err(|error| format!("read model monitor size failed: {error}"))?;
    let x = monitor.position().x + ((monitor.size().width as i32 - width.width as i32) / 2).max(0);
    let y = monitor.position().y + (TOP_GUTTER * monitor.scale_factor()).round() as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("reposition model monitor failed: {error}"))
}

fn position_model_monitor(window: &WebviewWindow, expanded: bool) -> Result<(), String> {
    let (width, height) = if expanded {
        (EXPANDED_WIDTH, EXPANDED_HEIGHT)
    } else {
        (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    };
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| format!("resize model monitor failed: {error}"))?;

    let monitor = target_monitor(window);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let physical_width = (width * monitor.scale_factor()).round() as i32;
    let x = monitor.position().x + ((monitor.size().width as i32 - physical_width) / 2).max(0);
    let y = monitor.position().y + (TOP_GUTTER * monitor.scale_factor()).round() as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("position model monitor failed: {error}"))?;
    Ok(())
}

fn target_monitor(window: &WebviewWindow) -> Option<tauri::Monitor> {
    // 跟随主窗口所在屏幕，而不是固定跟随 primary display；换显示器/改变排列后
    // 主窗口仍是用户当前工作区的可靠锚点。
    window
        .app_handle()
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
}

#[cfg(target_os = "macos")]
fn configure_macos_status_window(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let raw = window
        .ns_window()
        .map_err(|error| format!("get model monitor NSWindow failed: {error}"))?;
    // SAFETY: Tauri owns `raw` for at least as long as `window`; setup runs on the
    // AppKit main thread and we only mutate documented NSWindow presentation flags.
    let ns_window: &NSWindow = unsafe { &*raw.cast() };
    ns_window.setLevel(NSStatusWindowLevel);
    // status-level window 默认不激活；显式接收 mouse-moved，才能像系统状态项一样
    // 在不抢走当前 app 键盘焦点的前提下响应 hover。
    ns_window.setAcceptsMouseMovedEvents(true);
    ns_window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    Ok(())
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
        assert!(EXPANDED_HEIGHT > COLLAPSED_HEIGHT);
        assert!(COLLAPSED_HEIGHT <= 36.0);
    }
}
