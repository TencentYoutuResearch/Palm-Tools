//! 底部全局状态栏。

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::app::{App, SidebarMode};
use crate::keymap::Mode;
use kode_core::session::state::Status;

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    // 模式提示在最右
    let mode_label: String = match &app.mode {
        Mode::Normal => String::new(),
        Mode::Prefix => " PREFIX ".to_string(),
        Mode::Confirm { prompt, .. } => prompt.clone(),
        Mode::Rename { buf } => format!("rename: {buf}_"),
        Mode::Scroll => {
            if let Some(s) = app.tabs.get(app.active) {
                format!(" SCROLL ↑{} (Esc/q exit) ", s.scrollback_offset())
            } else {
                " SCROLL (Esc/q exit) ".to_string()
            }
        }
    };

    // active session 信息
    let (model, cost, tokens, status_label, status_color) =
        if let Some(s) = app.tabs.get(app.active) {
            let dot_color = match s.state.status {
                Status::Starting => Color::Yellow,
                Status::Idle => Color::Green,
                Status::Busy => Color::Cyan,
                Status::Exited(_) => Color::Red,
            };
            let cost = s
                .state
                .cost_usd
                .map(|v| format!("${v:.2}"))
                .unwrap_or_else(|| "$--".into());
            let tokens = s
                .state
                .tokens
                .map(|t| format_compact(t))
                .unwrap_or_else(|| "--".into());
            (
                crate::ui::tablist::compact_model_name(&s.state.model),
                cost,
                tokens,
                s.state.status.label(),
                dot_color,
            )
        } else {
            (
                "--".into(),
                "$--".into(),
                "--".into(),
                "n/a",
                Color::DarkGray,
            )
        };

    let zoom_marker = match app.sidebar {
        SidebarMode::Full => "",
        SidebarMode::Compact => "[compact] ",
        SidebarMode::Hidden => "[zoom] ",
    };

    let left = Line::from(vec![
        Span::styled(zoom_marker, Style::default().fg(Color::Yellow)),
        Span::styled(
            format!(
                "{}/{} ",
                app.active.saturating_add(1).min(app.tabs.len()),
                app.tabs.len()
            ),
            Style::default().fg(Color::DarkGray),
        ),
        Span::styled("● ", Style::default().fg(status_color)),
        Span::styled(
            format!("{status_label} "),
            Style::default().fg(status_color),
        ),
        Span::raw("│ "),
        Span::styled("model: ", Style::default().fg(Color::DarkGray)),
        Span::styled(model, Style::default().fg(Color::White)),
        Span::raw("  "),
        Span::styled("tokens: ", Style::default().fg(Color::DarkGray)),
        Span::styled(tokens, Style::default().fg(Color::White)),
        Span::raw("  "),
        Span::styled(cost, Style::default().fg(Color::Green)),
    ]);

    let right_text = if !mode_label.is_empty() {
        format!("{mode_label}  C-b ? help  C-b q quit")
    } else {
        "C-b ? help  C-b q quit".to_string()
    };
    let right_style = if matches!(app.mode, Mode::Prefix) {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Yellow)
            .add_modifier(Modifier::BOLD)
    } else if matches!(app.mode, Mode::Scroll) {
        Style::default()
            .fg(Color::Black)
            .bg(Color::Magenta)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    // 拼成两段:左 + 右对齐
    let left_str = render_line_to_string(&left);
    let used = left_str.chars().count() as u16;
    let right_w = right_text.chars().count() as u16;
    let pad = area.width.saturating_sub(used).saturating_sub(right_w);

    let line = Line::from(
        left.spans
            .into_iter()
            .chain(std::iter::once(Span::raw(" ".repeat(pad as usize))))
            .chain(std::iter::once(Span::styled(right_text, right_style)))
            .collect::<Vec<_>>(),
    );

    let p = Paragraph::new(line);
    frame.render_widget(p, area);
}

fn render_line_to_string(line: &Line) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

fn format_compact(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}
