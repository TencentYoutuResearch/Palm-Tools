//! 系统级 model token 刘海窗口。
//!
//! 在带刘海的 MacBook 屏幕上，前端会读取这里返回的 `NSScreen` 安全区和辅助
//! 顶部区域，把真实硬件刘海作为组件中央，信息只画在左右菜单栏安全区。外接
//! 无刘海屏使用同一套连续轮廓和标准 185pt 模拟刘海，避免维护第二套交互。
//!
//! 收起时窗口高度只覆盖菜单栏，避免透明大窗口拦截桌面点击；展开时由前端
//! invoke 调整为完整面板尺寸。macOS 额外提升到 status-window 层，并允许出现在
//! 所有 Space / 全屏桌面中，效果不依附 kode 主窗口 titlebar。

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MODEL_MONITOR_LABEL: &str = "kode-model-monitor";
const MODEL_MONITOR_LAYOUT_EVENT: &str = "model-monitor-layout-changed";
const COLLAPSED_WIDTH: f64 = 440.0;
const COLLAPSED_HEIGHT: f64 = 34.0;
const SIMULATED_NOTCH_WIDTH: f64 = 185.0;
const EXPANDED_WIDTH: f64 = 660.0;
// 面板内容约 650 logical px；只为边缘留少量透明余量，避免底部出现一大片
// 空的阴影区域，也减少透明窗口拦截桌面点击的范围。
const EXPANDED_HEIGHT: f64 = 720.0;

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
        let main_for_events = main.clone();
        let initial_signature = main.current_monitor().ok().flatten().map(monitor_signature);
        let last_signature = Arc::new(Mutex::new(initial_signature));
        main.on_window_event(move |event| {
            match event {
                tauri::WindowEvent::Destroyed => {
                    let _ = monitor.close();
                }
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    let next_signature = main_for_events
                        .current_monitor()
                        .ok()
                        .flatten()
                        .map(monitor_signature);
                    let changed = last_signature.lock().ok().is_some_and(|mut last| {
                        if *last == next_signature {
                            false
                        } else {
                            *last = next_signature;
                            true
                        }
                    });
                    if changed {
                        match reposition_model_monitor(&monitor) {
                            Ok(layout) => {
                                let _ = monitor.emit(MODEL_MONITOR_LAYOUT_EVENT, layout);
                            }
                            Err(error) => {
                                tracing::warn!(%error, "reposition model monitor after display change failed");
                            }
                        }
                    }
                }
                _ => {}
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

/// 显示器排列/主屏变化后重新定位并返回目标屏幕的刘海几何。只有收起态跨越
/// 不同刘海/菜单栏高度时才校正高度，日常巡检不会反复 resize。
#[tauri::command]
pub fn model_monitor_reposition(window: WebviewWindow) -> Result<ModelMonitorLayout, String> {
    if window.label() != MODEL_MONITOR_LABEL {
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
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("reposition model monitor failed: {error}"))?;
    // NSWindow.screen must be read after moving: otherwise the first poll after a
    // cross-display move returns the old display's notch geometry.
    let layout = model_monitor_layout(&window, &monitor);
    let size = window
        .inner_size()
        .map_err(|error| format!("read model monitor size on target screen failed: {error}"))?;
    let logical_width = size.width as f64 / monitor.scale_factor();
    let logical_height = size.height as f64 / monitor.scale_factor();
    let collapsed_height = layout.collapsed_height();
    if (logical_width - COLLAPSED_WIDTH).abs() < 1.0
        && (logical_height - collapsed_height).abs() >= 1.0
    {
        window
            .set_size(tauri::LogicalSize::new(COLLAPSED_WIDTH, collapsed_height))
            .map_err(|error| format!("resize model monitor for target screen failed: {error}"))?;
    }
    Ok(layout)
}

fn position_model_monitor(window: &WebviewWindow, expanded: bool) -> Result<(), String> {
    let monitor = target_monitor(window);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let (width, initial_height) = if expanded {
        (EXPANDED_WIDTH, EXPANDED_HEIGHT)
    } else {
        (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    };
    window
        .set_size(tauri::LogicalSize::new(width, initial_height))
        .map_err(|error| format!("resize model monitor failed: {error}"))?;

    let physical_width = (width * monitor.scale_factor()).round() as i32;
    let x = monitor.position().x + ((monitor.size().width as i32 - physical_width) / 2).max(0);
    let y = monitor.position().y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("position model monitor failed: {error}"))?;
    if !expanded {
        let collapsed_height = model_monitor_layout(window, &monitor).collapsed_height();
        if (collapsed_height - initial_height).abs() >= 1.0 {
            window
                .set_size(tauri::LogicalSize::new(width, collapsed_height))
                .map_err(|error| format!("resize model monitor for notch failed: {error}"))?;
        }
    }
    Ok(())
}

fn model_monitor_layout(window: &WebviewWindow, monitor: &tauri::Monitor) -> ModelMonitorLayout {
    platform_model_monitor_layout(window).unwrap_or_else(|| ModelMonitorLayout::fallback(monitor))
}

#[cfg(target_os = "macos")]
fn platform_model_monitor_layout(window: &WebviewWindow) -> Option<ModelMonitorLayout> {
    use objc2_app_kit::NSWindow;

    // The monitor window's `screen` can lag one AppKit cycle immediately after
    // setFrameOrigin. The main window is the source of truth for target_monitor, so
    // read its NSScreen directly and fall back to the monitor window only when main
    // is unavailable.
    let raw = window
        .app_handle()
        .get_webview_window("main")
        .and_then(|main| main.ns_window().ok())
        .or_else(|| window.ns_window().ok())?;
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
    // 跟随主窗口所在屏幕，而不是固定跟随 primary display；换显示器/改变排列后
    // 主窗口仍是用户当前工作区的可靠锚点。
    window
        .app_handle()
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
}

fn monitor_signature(monitor: tauri::Monitor) -> (i32, i32, u32, u32, u64) {
    (
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        monitor.scale_factor().to_bits(),
    )
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
}
