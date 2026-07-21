//! 左侧 tab 列表 widget。

use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem};
use ratatui::Frame;

use crate::app::{App, SidebarMode};
use kode_core::session::state::Status;

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    if app.sidebar == SidebarMode::Compact {
        render_compact(frame, area, app);
    } else {
        render_full(frame, area, app);
    }
}

/// 简略模式(8 列宽,扣掉 1 列右边框 → 内容 7 列):
/// 单行显示 `>` active 标记 + 序号 + 状态点 + 未读 + 一两位标题首字符
/// 提示信息靠 status dot 颜色 + 未读点 + 数字快捷键号传达。
fn render_compact(frame: &mut Frame, area: Rect, app: &App) {
    let items: Vec<ListItem> = app
        .tabs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let is_active = i == app.active;
            let dot_color = match s.state.status {
                Status::Starting => Color::Yellow,
                Status::Idle => Color::Green,
                Status::Busy => Color::Cyan,
                Status::Exited(_) => Color::Red,
            };
            // 数字键提示:1..9 直接,10 显示 0
            let nidx = i + 1;
            let nlabel = if nidx == 10 {
                "0".to_string()
            } else if nidx > 10 {
                "·".to_string()
            } else {
                nidx.to_string()
            };
            let active_marker = if is_active { ">" } else { " " };
            let unread_marker = if s.state.unread && !is_active {
                "•"
            } else {
                " "
            };
            // 标题首字 1 个 char,UTF-8 安全
            let head = s
                .state
                .title
                .chars()
                .next()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "·".into());
            let title_style = if is_active {
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::Gray)
            };
            // 总宽 7:active(1) + idx(1) + dot(1) + space(1) + unread(1) + head(1) + pad(1)
            let line = Line::from(vec![
                Span::styled(
                    active_marker.to_string(),
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(nlabel, Style::default().fg(Color::DarkGray)),
                Span::styled(
                    s.state.status.dot().to_string(),
                    Style::default().fg(dot_color),
                ),
                Span::raw(" "),
                Span::styled(unread_marker, Style::default().fg(Color::Magenta)),
                Span::styled(head, title_style),
            ]);
            ListItem::new(vec![line])
        })
        .collect();

    let block = Block::default().borders(Borders::RIGHT).title(Span::styled(
        "k",
        Style::default()
            .fg(Color::White)
            .bg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    ));
    let list = List::new(items).block(block);
    frame.render_widget(list, area);
}

fn render_full(frame: &mut Frame, area: Rect, app: &App) {
    // 第二行的左缩进 4 列(对齐 line1 的 title 起点),右边再留 1 列给状态文字 +
    // 1 列边框间隔,模型名最多用这么宽:
    let model_max = (area.width as usize).saturating_sub(4 + 1 + 6); // 4 缩进 + 1 边框 + 6 给 status label("idle"/"busy"/...)
    let model_max = model_max.max(4); // 至少 4 列

    let items: Vec<ListItem> = app
        .tabs
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let is_active = i == app.active;
            let dot_color = match s.state.status {
                Status::Starting => Color::Yellow,
                Status::Idle => Color::Green,
                Status::Busy => Color::Cyan,
                Status::Exited(_) => Color::Red,
            };
            let unread_marker = if s.state.unread && !is_active {
                "•"
            } else {
                " "
            };
            let title = if s.state.title.len() as u16 > area.width.saturating_sub(8) {
                let max = area.width.saturating_sub(8) as usize;
                format!(
                    "{}…",
                    s.state
                        .title
                        .chars()
                        .take(max.saturating_sub(1))
                        .collect::<String>()
                )
            } else {
                s.state.title.clone()
            };
            let line1 = Line::from(vec![
                Span::raw(format!("{:>2} ", i + 1)),
                Span::styled(
                    s.state.status.dot().to_string(),
                    Style::default().fg(dot_color),
                ),
                Span::raw(" "),
                Span::styled(unread_marker, Style::default().fg(Color::Magenta)),
                Span::raw(" "),
                Span::styled(
                    title,
                    if is_active {
                        Style::default()
                            .add_modifier(Modifier::BOLD)
                            .fg(Color::White)
                    } else {
                        Style::default().fg(Color::Gray)
                    },
                ),
            ]);
            let model_short = compact_model_name(&s.state.model);
            let model_show = trunc(&model_short, model_max);
            let line2 = Line::from(vec![
                Span::raw("    "),
                Span::styled(model_show, Style::default().fg(Color::DarkGray)),
                Span::raw(" "),
                Span::styled(
                    s.state.status.label(),
                    Style::default().fg(dot_color).add_modifier(Modifier::DIM),
                ),
            ]);
            ListItem::new(vec![line1, line2])
        })
        .collect();

    let mut block = Block::default().borders(Borders::RIGHT).title(Span::styled(
        " kode ",
        Style::default()
            .fg(Color::White)
            .bg(Color::DarkGray)
            .add_modifier(Modifier::BOLD),
    ));
    block = block.title_bottom(Span::styled(
        format!(
            " {}/{} ",
            app.active.saturating_add(1).min(app.tabs.len()),
            app.tabs.len()
        ),
        Style::default().fg(Color::DarkGray),
    ));

    let list = List::new(items).block(block);
    frame.render_widget(list, area);
}

fn trunc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars()
            .take(max.saturating_sub(1))
            .chain(std::iter::once('…'))
            .collect()
    }
}

/// 把长模型名压成展示友好的短名。已统一到 `kode_core::short_model_name`,
/// 本函数只是**薄 wrapper**,保留原签名让上层 / 单测无需改动。
pub fn compact_model_name(raw: &str) -> String {
    kode_core::short_model_name(raw)
}

#[cfg(test)]
mod tests {
    use super::compact_model_name;

    #[test]
    fn compact_claude_opus_dotted() {
        assert_eq!(compact_model_name("claude-opus-4.7"), "opus-4.7");
    }

    #[test]
    fn compact_claude_opus_with_1m_suffix() {
        assert_eq!(compact_model_name("claude-opus-4.7-1m"), "opus-4.7-1m");
    }

    #[test]
    fn compact_anthropic_dashed_version_with_date() {
        // anthropic API 风格:"claude-sonnet-4-5-20250929" → "sonnet-4.5"
        assert_eq!(
            compact_model_name("claude-sonnet-4-5-20250929"),
            "sonnet-4.5"
        );
    }

    #[test]
    fn compact_gpt_passthrough() {
        // 没有 claude- 前缀,且第一个 token 不是数字 → 走非数字分支保留原样
        assert_eq!(compact_model_name("gpt-5.3-codex"), "gpt-5.3-codex");
    }

    #[test]
    fn compact_gemini_passthrough() {
        assert_eq!(compact_model_name("gemini-3.1-pro"), "gemini-3.1-pro");
    }

    #[test]
    fn compact_unknown_raw() {
        assert_eq!(compact_model_name("foo"), "foo");
        assert_eq!(compact_model_name(""), "");
        assert_eq!(compact_model_name("auto"), "auto");
    }
}
