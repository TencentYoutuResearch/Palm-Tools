//! 鼠标事件:把全局坐标转换成相对 PTY 区的坐标,并编码为 SGR(?1006)字节序列。

use crossterm::event::{KeyModifiers, MouseEvent, MouseEventKind};
use ratatui::layout::Rect;

use crate::action::Action;

/// 解析鼠标事件 → Action。点击 tab 栏会产生 GotoTab,落在 PTY 区会产生 PassthroughMouse。
pub fn handle_mouse(
    ev: MouseEvent,
    pty_area: Rect,
    sidebar_area: Option<Rect>,
    tab_count: usize,
) -> Option<Action> {
    let col = ev.column;
    let row = ev.row;

    // 鼠标点击落在 sidebar:左侧 tab 栏
    if let Some(sb) = sidebar_area {
        if col >= sb.x && col < sb.x + sb.width && row >= sb.y && row < sb.y + sb.height {
            if matches!(ev.kind, MouseEventKind::Down(_)) {
                // 每个 tab 占两行(line1 + line2);第 0 行是顶部 title 边框留出?
                // 简单处理:从 sidebar 顶部起 row=0..,每 2 行一个 tab
                let local_y = row.saturating_sub(sb.y) as usize;
                let idx = local_y / 2;
                if idx < tab_count {
                    return Some(Action::GotoTab(idx + 1));
                }
            }
            return None;
        }
    }

    // 落在 PTY 区
    if col < pty_area.x || col >= pty_area.x + pty_area.width {
        return None;
    }
    if row < pty_area.y || row >= pty_area.y + pty_area.height {
        return None;
    }
    let local_col = col - pty_area.x;
    let local_row = row - pty_area.y;
    Some(Action::PassthroughMouse {
        col: local_col,
        row: local_row,
        kind: ev.kind,
        modifiers: ev.modifiers,
    })
}

/// 把 PassthroughMouse 编成 SGR ?1006 字节序列发给 PTY。
/// 格式: ESC [ < Cb ; Cx ; Cy (M|m)
pub fn encode_mouse_sgr(
    col: u16,
    row: u16,
    kind: MouseEventKind,
    modifiers: KeyModifiers,
) -> Option<Vec<u8>> {
    let (button, is_release) = match kind {
        MouseEventKind::Down(b) => (button_code(b), false),
        MouseEventKind::Up(b) => (button_code(b), true),
        MouseEventKind::Drag(b) => (button_code(b) + 32, false),
        MouseEventKind::Moved => return None, // 默认不上报 motion
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        MouseEventKind::ScrollLeft => (66, false),
        MouseEventKind::ScrollRight => (67, false),
    };
    let mut cb = button;
    if modifiers.contains(KeyModifiers::SHIFT) {
        cb += 4;
    }
    if modifiers.contains(KeyModifiers::ALT) {
        cb += 8;
    }
    if modifiers.contains(KeyModifiers::CONTROL) {
        cb += 16;
    }
    let suffix = if is_release { 'm' } else { 'M' };
    // PTY 坐标是 1-based
    let s = format!("\x1b[<{};{};{}{}", cb, col + 1, row + 1, suffix);
    Some(s.into_bytes())
}

fn button_code(b: crossterm::event::MouseButton) -> u32 {
    match b {
        crossterm::event::MouseButton::Left => 0,
        crossterm::event::MouseButton::Middle => 1,
        crossterm::event::MouseButton::Right => 2,
    }
}
