//! 帮助 overlay(C-b ? 触发)。

use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};
use ratatui::Frame;

const HELP_LINES: &[(&str, &str)] = &[
    ("C-b c", "新建 tab(默认后端)"),
    ("C-b C", "新建 tab(claude)"),
    ("C-b x", "关闭当前 tab"),
    ("C-b n / p", "下/上一个 tab"),
    ("C-b 1..9, 0", "跳到第 N 个 tab(0 = 第 10)"),
    ("C-b z", "切换 zoom(等同 C-b b)"),
    ("C-b b", "侧栏循环 完整 → 简略 → 隐藏"),
    ("C-b ,", "重命名当前 session 标题"),
    ("C-b r", "重启已退出的 tab"),
    ("C-b [", "进入 scrollback 翻看模式(↑/↓ k/j PgUp/PgDn g/G)"),
    ("scroll wheel", "PTY 区滚轮自动进入 scrollback"),
    ("C-b ?", "切换此帮助"),
    ("C-b q", "退出 kode"),
    ("C-b C-b", "向 PTY 发送真实 Ctrl-b"),
];

pub fn render(frame: &mut Frame, full: Rect) {
    let area = center(full, 60, (HELP_LINES.len() as u16) + 4);
    frame.render_widget(Clear, area);

    let mut lines = vec![Line::from(Span::styled(
        "Keybindings",
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    ))];
    lines.push(Line::raw(""));
    for (k, d) in HELP_LINES {
        lines.push(Line::from(vec![
            Span::styled(format!("{:<14}", k), Style::default().fg(Color::Cyan)),
            Span::styled(d.to_string(), Style::default().fg(Color::Gray)),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "press C-b ? again to dismiss",
        Style::default().fg(Color::DarkGray),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow))
        .title(" help ");
    let p = Paragraph::new(lines)
        .block(block)
        .alignment(Alignment::Left);
    frame.render_widget(p, area);
}

fn center(full: Rect, w: u16, h: u16) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(full.height.saturating_sub(h) / 2),
            Constraint::Length(h.min(full.height)),
            Constraint::Min(0),
        ])
        .split(full);
    let hl = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(full.width.saturating_sub(w) / 2),
            Constraint::Length(w.min(full.width)),
            Constraint::Min(0),
        ])
        .split(v[1]);
    hl[1]
}
