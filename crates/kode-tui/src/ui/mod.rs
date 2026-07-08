//! 顶层 draw():编排布局,分发各 widget。

pub mod help;
pub mod statusbar;
pub mod tablist;
pub mod terminal;

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::Frame;

use crate::app::{App, SidebarMode};

/// 计算右侧 PTY 区(可能用于鼠标坐标转换)
pub fn pty_area(frame_size: Rect, sidebar_w: u16, sidebar: SidebarMode) -> Rect {
    let main = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(frame_size);
    let top = main[0];
    let actual_w = sidebar.width(sidebar_w);
    if actual_w == 0 {
        return top;
    }
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(actual_w), Constraint::Min(1)])
        .split(top);
    cols[1]
}

pub fn draw(frame: &mut Frame, app: &App) {
    let size = frame.area();

    let main = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(size);
    let top = main[0];
    let bottom = main[1];

    let sidebar_w = app.sidebar.width(app.config.ui.sidebar_width);
    let (sidebar_area, pty_area) = if sidebar_w == 0 {
        (None, top)
    } else {
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(sidebar_w), Constraint::Min(1)])
            .split(top);
        (Some(cols[0]), cols[1])
    };

    if let Some(area) = sidebar_area {
        tablist::render(frame, area, app);
    }
    terminal::render(frame, pty_area, app);
    statusbar::render(frame, bottom, app);

    if app.show_help {
        help::render(frame, size);
    }
}
