//! 键盘事件 → Action 的映射,核心是 tmux 风 prefix(Ctrl-b)状态机。
//!
//! 模式:
//!   Normal      — 直通 PTY,只拦截 Ctrl-b 进入 Prefix
//!   Prefix      — 等待下一个键作为命令
//!   Confirm(_)  — 等待 y/n 确认某个 Action(如关闭 tab)
//!   Rename(_)   — 重命名 title 模式
//!   Scroll      — scrollback 翻看模式(C-b [ 进入,Esc/q 退出),按键不透传 PTY

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::action::Action;

#[derive(Debug, Clone)]
pub enum Mode {
    Normal,
    Prefix,
    Confirm { prompt: String, on_yes: Box<Action> },
    Rename { buf: String },
    Scroll,
}

impl Mode {
    pub fn is_normal(&self) -> bool {
        matches!(self, Mode::Normal)
    }
}

/// keymap 处理结果
pub enum Handled {
    /// 没要执行的 Action,但 mode 可能变了
    None,
    /// 产生一个 Action
    Action(Action),
    /// 多个 Action(罕见,目前未使用)
    Multi(Vec<Action>),
}

pub fn handle_key(mode: &mut Mode, key: KeyEvent, default_backend: &str) -> Handled {
    // 忽略 release 事件,只处理 Press / Repeat
    if matches!(key.kind, KeyEventKind::Release) {
        return Handled::None;
    }

    match std::mem::replace(mode, Mode::Normal) {
        Mode::Normal => handle_normal(mode, key, default_backend),
        Mode::Prefix => handle_prefix(mode, key, default_backend),
        Mode::Confirm { prompt, on_yes } => handle_confirm(mode, key, prompt, *on_yes),
        Mode::Rename { buf } => handle_rename(mode, key, buf),
        Mode::Scroll => handle_scroll(mode, key),
    }
}

fn handle_normal(mode: &mut Mode, key: KeyEvent, _default_backend: &str) -> Handled {
    // Ctrl-b → 进入 prefix
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b') {
        *mode = Mode::Prefix;
        return Handled::None;
    }

    // 其他所有按键 → 直通 PTY(编码成字节流)
    *mode = Mode::Normal;
    if let Some(bytes) = encode_key_for_pty(key) {
        return Handled::Action(Action::PassthroughBytes(bytes));
    }
    Handled::None
}

fn handle_prefix(mode: &mut Mode, key: KeyEvent, default_backend: &str) -> Handled {
    *mode = Mode::Normal; // prefix 命令默认消耗后回 Normal

    // Ctrl-b Ctrl-b → 把 Ctrl-b 字节透传给 PTY(让 tmux/emacs 用户能输出真正的 Ctrl-b)
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b') {
        return Handled::Action(Action::PassthroughBytes(vec![0x02]));
    }

    let action = match key.code {
        KeyCode::Char('q') => Action::Quit,
        KeyCode::Char('c') => Action::NewTab(default_backend.to_string()),
        KeyCode::Char('C') => Action::NewTab("claude".into()),
        KeyCode::Char('n') => Action::NextTab,
        KeyCode::Char('p') => Action::PrevTab,
        KeyCode::Char('z') => Action::ToggleZoom,
        KeyCode::Char('b') => Action::CycleSidebar,
        KeyCode::Char('?') => Action::ToggleHelp,
        KeyCode::Char(',') => Action::BeginRename,
        KeyCode::Char('r') => Action::RestartActiveTab,
        KeyCode::Char('[') => {
            // 进入 scrollback 翻看模式
            *mode = Mode::Scroll;
            return Handled::Action(Action::EnterScrollMode);
        }
        KeyCode::Char('x') => {
            *mode = Mode::Confirm {
                prompt: "Close current tab? [y/N]".into(),
                on_yes: Box::new(Action::CloseActiveTab),
            };
            return Handled::None;
        }
        KeyCode::Char(c @ '0'..='9') => {
            let n = c.to_digit(10).unwrap() as usize;
            // 0 => 第 10 个;1..9 => 第 1..9 个
            let idx = if n == 0 { 10 } else { n };
            Action::GotoTab(idx)
        }
        // 未识别的 prefix 命令 → 直接放弃,不透传
        _ => return Handled::None,
    };
    Handled::Action(action)
}

fn handle_confirm(mode: &mut Mode, key: KeyEvent, prompt: String, on_yes: Action) -> Handled {
    match key.code {
        KeyCode::Char('y') | KeyCode::Char('Y') => {
            *mode = Mode::Normal;
            Handled::Action(on_yes)
        }
        KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => {
            *mode = Mode::Normal;
            Handled::None
        }
        _ => {
            // 保持在 confirm 模式
            *mode = Mode::Confirm {
                prompt,
                on_yes: Box::new(on_yes),
            };
            Handled::None
        }
    }
}

fn handle_rename(mode: &mut Mode, key: KeyEvent, mut buf: String) -> Handled {
    match key.code {
        KeyCode::Esc => {
            *mode = Mode::Normal;
            Handled::None
        }
        KeyCode::Enter => {
            *mode = Mode::Normal;
            // 重命名 Action 在 App 那边消化(从 mode 拿 buf;此处先用 Multi 简单方案)
            Handled::Multi(vec![/* App 会根据 mode 退出时的 buf 重命名 */])
        }
        KeyCode::Backspace => {
            buf.pop();
            *mode = Mode::Rename { buf };
            Handled::None
        }
        KeyCode::Char(c) => {
            buf.push(c);
            *mode = Mode::Rename { buf };
            Handled::None
        }
        _ => {
            *mode = Mode::Rename { buf };
            Handled::None
        }
    }
}

/// scrollback 翻看模式:按键不透传 PTY,只翻 vt100 历史。
/// 退出键:Esc / q / Enter / C-c。
fn handle_scroll(mode: &mut Mode, key: KeyEvent) -> Handled {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
            *mode = Mode::Normal;
            Handled::Action(Action::ExitScrollMode)
        }
        KeyCode::Char('c') if ctrl => {
            *mode = Mode::Normal;
            Handled::Action(Action::ExitScrollMode)
        }
        KeyCode::Up | KeyCode::Char('k') => {
            *mode = Mode::Scroll;
            Handled::Action(Action::ScrollUpLines(1))
        }
        KeyCode::Down | KeyCode::Char('j') => {
            *mode = Mode::Scroll;
            Handled::Action(Action::ScrollDownLines(1))
        }
        KeyCode::PageUp | KeyCode::Char('b') => {
            *mode = Mode::Scroll;
            Handled::Action(Action::ScrollPageUp)
        }
        KeyCode::PageDown | KeyCode::Char('f') | KeyCode::Char(' ') => {
            *mode = Mode::Scroll;
            Handled::Action(Action::ScrollPageDown)
        }
        KeyCode::Home | KeyCode::Char('g') => {
            *mode = Mode::Scroll;
            Handled::Action(Action::ScrollHome)
        }
        KeyCode::End | KeyCode::Char('G') => {
            *mode = Mode::Scroll;
            Handled::Action(Action::ScrollEnd)
        }
        // 其它键直接吃掉,留在 Scroll 模式
        _ => {
            *mode = Mode::Scroll;
            Handled::None
        }
    }
}

/// 把 KeyEvent 编码成 PTY 期望的字节序列。
/// 仅覆盖 MVP 常用范围:可打印字符、回车、退格、Tab、方向键、Esc、Ctrl 组合。
fn encode_key_for_pty(key: KeyEvent) -> Option<Vec<u8>> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);

    let mut out: Vec<u8> = Vec::new();

    // Alt 前缀 → ESC
    let with_alt_esc = |out: &mut Vec<u8>| {
        if alt {
            out.push(0x1b);
        }
    };

    match key.code {
        KeyCode::Char(c) => {
            with_alt_esc(&mut out);
            if ctrl {
                let cl = c.to_ascii_lowercase();
                let b = match cl {
                    'a'..='z' => Some((cl as u8) - b'a' + 1),
                    ' ' => Some(0x00),
                    '[' => Some(0x1b),
                    '\\' => Some(0x1c),
                    ']' => Some(0x1d),
                    '^' => Some(0x1e),
                    '_' => Some(0x1f),
                    '?' => Some(0x7f),
                    _ => None,
                };
                match b {
                    Some(b) => out.push(b),
                    None => {
                        // 退化:输出原字符
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                    }
                }
            } else {
                let mut buf = [0u8; 4];
                let s = c.encode_utf8(&mut buf);
                out.extend_from_slice(s.as_bytes());
            }
        }
        KeyCode::Enter => {
            with_alt_esc(&mut out);
            out.push(b'\r');
        }
        KeyCode::Tab => {
            with_alt_esc(&mut out);
            if shift {
                out.extend_from_slice(b"\x1b[Z");
            } else {
                out.push(b'\t');
            }
        }
        KeyCode::Backspace => {
            with_alt_esc(&mut out);
            out.push(0x7f);
        }
        KeyCode::Esc => {
            // Esc 自身就是 0x1b;Alt+Esc 实际上还是单 Esc
            out.push(0x1b);
        }
        KeyCode::Up => {
            with_alt_esc(&mut out);
            out.extend_from_slice(b"\x1b[A");
        }
        KeyCode::Down => {
            with_alt_esc(&mut out);
            out.extend_from_slice(b"\x1b[B");
        }
        KeyCode::Right => {
            with_alt_esc(&mut out);
            out.extend_from_slice(b"\x1b[C");
        }
        KeyCode::Left => {
            with_alt_esc(&mut out);
            out.extend_from_slice(b"\x1b[D");
        }
        KeyCode::Home => out.extend_from_slice(b"\x1b[H"),
        KeyCode::End => out.extend_from_slice(b"\x1b[F"),
        KeyCode::PageUp => out.extend_from_slice(b"\x1b[5~"),
        KeyCode::PageDown => out.extend_from_slice(b"\x1b[6~"),
        KeyCode::Delete => out.extend_from_slice(b"\x1b[3~"),
        KeyCode::Insert => out.extend_from_slice(b"\x1b[2~"),
        KeyCode::F(n) => {
            // F1-F4 用 SS3,F5+ 用 CSI ~
            match n {
                1 => out.extend_from_slice(b"\x1bOP"),
                2 => out.extend_from_slice(b"\x1bOQ"),
                3 => out.extend_from_slice(b"\x1bOR"),
                4 => out.extend_from_slice(b"\x1bOS"),
                5 => out.extend_from_slice(b"\x1b[15~"),
                6 => out.extend_from_slice(b"\x1b[17~"),
                7 => out.extend_from_slice(b"\x1b[18~"),
                8 => out.extend_from_slice(b"\x1b[19~"),
                9 => out.extend_from_slice(b"\x1b[20~"),
                10 => out.extend_from_slice(b"\x1b[21~"),
                11 => out.extend_from_slice(b"\x1b[23~"),
                12 => out.extend_from_slice(b"\x1b[24~"),
                _ => return None,
            }
        }
        _ => return None,
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn kc(code: KeyCode, m: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, m)
    }

    #[test]
    fn prefix_then_n_yields_next_tab() {
        let mut mode = Mode::Normal;
        let r = handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        assert!(matches!(r, Handled::None));
        assert!(matches!(mode, Mode::Prefix));

        let r = handle_key(&mut mode, k(KeyCode::Char('n')), "codebuddy");
        assert!(matches!(r, Handled::Action(Action::NextTab)));
        assert!(matches!(mode, Mode::Normal));
    }

    #[test]
    fn double_ctrl_b_passes_through() {
        let mut mode = Mode::Normal;
        handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        let r = handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        match r {
            Handled::Action(Action::PassthroughBytes(bs)) => assert_eq!(bs, vec![0x02]),
            _ => panic!("expected passthrough 0x02"),
        }
    }

    #[test]
    fn plain_letter_passes_through() {
        let mut mode = Mode::Normal;
        let r = handle_key(&mut mode, k(KeyCode::Char('a')), "codebuddy");
        match r {
            Handled::Action(Action::PassthroughBytes(bs)) => assert_eq!(bs, vec![b'a']),
            _ => panic!(),
        }
    }

    #[test]
    fn ctrl_c_passes_through_as_etx() {
        let mut mode = Mode::Normal;
        let r = handle_key(
            &mut mode,
            kc(KeyCode::Char('c'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        match r {
            Handled::Action(Action::PassthroughBytes(bs)) => assert_eq!(bs, vec![0x03]),
            _ => panic!(),
        }
    }

    #[test]
    fn prefix_then_lbracket_enters_scroll_mode() {
        let mut mode = Mode::Normal;
        // C-b 进入 prefix
        let _ = handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        // [ 进入 scroll
        let r = handle_key(&mut mode, k(KeyCode::Char('[')), "codebuddy");
        match r {
            Handled::Action(Action::EnterScrollMode) => {}
            _ => panic!("expected EnterScrollMode"),
        }
        assert!(matches!(mode, Mode::Scroll));
    }

    #[test]
    fn scroll_mode_pageup_yields_scroll_action_and_stays_in_mode() {
        let mut mode = Mode::Scroll;
        let r = handle_key(&mut mode, k(KeyCode::PageUp), "codebuddy");
        assert!(matches!(r, Handled::Action(Action::ScrollPageUp)));
        assert!(matches!(mode, Mode::Scroll));

        // k 也滚一行
        let r = handle_key(&mut mode, k(KeyCode::Char('k')), "codebuddy");
        assert!(matches!(r, Handled::Action(Action::ScrollUpLines(1))));
        assert!(matches!(mode, Mode::Scroll));
    }

    #[test]
    fn scroll_mode_esc_exits_to_normal() {
        let mut mode = Mode::Scroll;
        let r = handle_key(&mut mode, k(KeyCode::Esc), "codebuddy");
        assert!(matches!(r, Handled::Action(Action::ExitScrollMode)));
        assert!(matches!(mode, Mode::Normal));
    }

    #[test]
    fn scroll_mode_q_exits_to_normal() {
        let mut mode = Mode::Scroll;
        let r = handle_key(&mut mode, k(KeyCode::Char('q')), "codebuddy");
        assert!(matches!(r, Handled::Action(Action::ExitScrollMode)));
        assert!(matches!(mode, Mode::Normal));
    }

    #[test]
    fn scroll_mode_swallows_unrelated_keys_no_passthrough() {
        let mut mode = Mode::Scroll;
        // 普通字母在 Scroll 模式下不应该透传给 PTY
        let r = handle_key(&mut mode, k(KeyCode::Char('a')), "codebuddy");
        assert!(matches!(r, Handled::None));
        assert!(matches!(mode, Mode::Scroll));
    }

    #[test]
    fn prefix_then_b_cycles_sidebar() {
        let mut mode = Mode::Normal;
        // C-b 进入 prefix
        let _ = handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        assert!(matches!(mode, Mode::Prefix));
        // 再按一个不带 Ctrl 的 'b' → CycleSidebar
        let r = handle_key(&mut mode, k(KeyCode::Char('b')), "codebuddy");
        assert!(matches!(r, Handled::Action(Action::CycleSidebar)));
        assert!(matches!(mode, Mode::Normal));
    }

    #[test]
    fn prefix_double_ctrl_b_still_passes_through_after_b_binding() {
        // 回归:加 'b' 键位绑定后,C-b C-b 仍然要透传 0x02 给 PTY
        let mut mode = Mode::Normal;
        let _ = handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        let r = handle_key(
            &mut mode,
            kc(KeyCode::Char('b'), KeyModifiers::CONTROL),
            "codebuddy",
        );
        match r {
            Handled::Action(Action::PassthroughBytes(bs)) => assert_eq!(bs, vec![0x02]),
            _ => panic!("expected passthrough 0x02"),
        }
    }
}
