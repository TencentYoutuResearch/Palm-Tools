//! 右侧 PTY 渲染:从 vt100::Screen 取 cell,逐格写入 ratatui Buffer。
//! 这是热路径,性能关键。

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::Widget;
use ratatui::Frame;

use crate::app::App;

pub fn render(frame: &mut Frame, area: Rect, app: &App) {
    if let Some(session) = app.tabs.get(app.active) {
        let widget = TerminalWidget {
            screen: session.parser.screen(),
        };
        frame.render_widget(widget, area);

        // scrollback 翻看时不定位硬件光标 —— 光标位置只对实时屏幕有意义,
        // 翻历史时显示光标会让人误以为光标在历史中央。
        let scrolled = session.parser.screen().scrollback() > 0;
        let (cy, cx) = session.parser.screen().cursor_position();
        if !scrolled && !session.parser.screen().hide_cursor() {
            let cx = (area.x + cx as u16).min(area.x + area.width.saturating_sub(1));
            let cy = (area.y + cy as u16).min(area.y + area.height.saturating_sub(1));
            frame.set_cursor_position((cx, cy));
        }
    } else {
        // 无 tab(理论上不会发生,App::ensure_one_tab 会兜底)
        let widget = ratatui::widgets::Paragraph::new("no session")
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(widget, area);
    }
}

struct TerminalWidget<'a> {
    screen: &'a vt100::Screen,
}

impl<'a> Widget for TerminalWidget<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let (rows, cols) = self.screen.size();
        let h = area.height.min(rows);
        let w = area.width.min(cols);

        for row in 0..h {
            for col in 0..w {
                let cell = match self.screen.cell(row, col) {
                    Some(c) => c,
                    None => continue,
                };
                let dst = match buf.cell_mut((area.x + col, area.y + row)) {
                    Some(c) => c,
                    None => continue,
                };

                // 字符内容
                let s = cell.contents();
                if s.is_empty() {
                    dst.set_char(' ');
                } else {
                    dst.set_symbol(s);
                }

                // 颜色 / 样式
                let mut style = Style::default();
                style = style.fg(convert_color(cell.fgcolor(), Color::Reset));
                style = style.bg(convert_color(cell.bgcolor(), Color::Reset));

                let mut m = Modifier::empty();
                if cell.bold() {
                    m |= Modifier::BOLD;
                }
                if cell.italic() {
                    m |= Modifier::ITALIC;
                }
                if cell.underline() {
                    m |= Modifier::UNDERLINED;
                }
                if cell.inverse() {
                    m |= Modifier::REVERSED;
                }
                style = style.add_modifier(m);
                dst.set_style(style);
            }
        }
    }
}

fn convert_color(c: vt100::Color, default: Color) -> Color {
    match c {
        vt100::Color::Default => default,
        vt100::Color::Idx(i) => indexed_to_color(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

fn indexed_to_color(i: u8) -> Color {
    match i {
        0 => Color::Black,
        1 => Color::Red,
        2 => Color::Green,
        3 => Color::Yellow,
        4 => Color::Blue,
        5 => Color::Magenta,
        6 => Color::Cyan,
        7 => Color::Gray,
        8 => Color::DarkGray,
        9 => Color::LightRed,
        10 => Color::LightGreen,
        11 => Color::LightYellow,
        12 => Color::LightBlue,
        13 => Color::LightMagenta,
        14 => Color::LightCyan,
        15 => Color::White,
        _ => Color::Indexed(i),
    }
}
