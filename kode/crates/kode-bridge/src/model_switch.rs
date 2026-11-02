//! Native PTY model controls. Only recognized model menus may receive keys;
//! delivery alone is never treated as acknowledgement.
use crate::{Ctx, EventEnvelope, SessionId};
use serde_json::json;
use std::{collections::HashSet, sync::OnceLock, time::Duration};

fn normalized(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn caption(text: &str) -> String {
    normalized(
        &text
            .split_whitespace()
            .filter(|word| {
                // Context window labels are presentation, not part of the model id.
                !word
                    .strip_suffix(['K', 'M'])
                    .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn cursor_base_label(label: &str) -> String {
    let mut words: Vec<_> = label
        .split("(NO ZDR)")
        .next()
        .unwrap_or(label)
        .split_whitespace()
        .collect();
    while words.last().is_some_and(|word| {
        matches!(
            word.to_ascii_lowercase().as_str(),
            "low"
                | "medium"
                | "high"
                | "extra"
                | "max"
                | "minimal"
                | "none"
                | "fast"
                | "thinking"
                | "no"
        ) || word
            .strip_suffix(['K', 'M'])
            .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
    }) {
        words.pop();
    }
    words.join(" ")
}

struct Switching((usize, SessionId));
static SWITCHING: OnceLock<parking_lot::Mutex<HashSet<(usize, SessionId)>>> = OnceLock::new();
impl Switching {
    fn acquire(ctx: &Ctx, id: SessionId) -> Result<Self, String> {
        let key = (ctx as *const Ctx as usize, id);
        if !SWITCHING.get_or_init(Default::default).lock().insert(key) {
            return Err("A model change is already in progress".into());
        }
        Ok(Self(key))
    }
}
impl Drop for Switching {
    fn drop(&mut self) {
        SWITCHING.get().unwrap().lock().remove(&self.0);
    }
}

#[derive(Debug, PartialEq)]
pub(super) enum Key {
    Up,
    Down,
    Enter,
    Session,
    Tab,
    Escape,
}
impl Key {
    pub(super) fn bytes(&self) -> &'static [u8] {
        match self {
            Self::Up => b"\x1b[A",
            Self::Down => b"\x1b[B",
            Self::Enter => b"\r",
            Self::Session => b"s",
            Self::Tab => b"\t",
            Self::Escape => b"\x1b",
        }
    }
}

fn selected(line: &str) -> bool {
    line.trim_start().starts_with(['›', '❯', '→', '>'])
}
fn row_text(line: &str) -> &str {
    line.trim().trim_start_matches(['›', '❯', '→', '>']).trim()
}

pub(super) fn numbered_rows(menu: &str) -> Vec<(&str, bool)> {
    menu.lines()
        .filter_map(|line| {
            let (number, text) = row_text(line).split_once(". ")?;
            (number.parse::<u16>().is_ok()).then_some((text, selected(line)))
        })
        .collect()
}

pub(super) fn navigate(rows: &[(&str, bool)], target: usize, accept: Key) -> Option<Key> {
    let current = rows.iter().position(|(_, active)| *active)?;
    Some(if current < target {
        Key::Down
    } else if current > target {
        Key::Up
    } else {
        accept
    })
}

fn codex_key(screen: &str, model: &str, effort: Option<&str>) -> Option<Key> {
    // Search from the bottom so old transcript text cannot impersonate a menu.
    if let Some((_, menu)) = screen.rsplit_once("Select Reasoning Level for ") {
        if !menu
            .lines()
            .next()
            .is_some_and(|label| normalized(label) == normalized(model))
        {
            return None;
        }
        if !menu.contains("esc") {
            return None;
        }
        let rows = numbered_rows(menu);
        let target = effort
            .and_then(|effort| {
                rows.iter().position(|(label, _)| {
                    label
                        .split_whitespace()
                        .next()
                        .is_some_and(|name| name.eq_ignore_ascii_case(effort))
                })
            })
            .or_else(|| rows.iter().position(|(_, current)| *current))?;
        let accept = if menu
            .lines()
            .any(|line| line.contains("esc") && line.contains("s session"))
        {
            Key::Session
        } else {
            Key::Enter
        };
        return navigate(&rows, target, accept);
    }
    let (_, menu) = screen.rsplit_once("Select Model")?;
    if !menu.contains("esc")
        || !menu.contains("enter")
        || !(menu.contains("select") || menu.contains("confirm"))
    {
        return None;
    }
    let rows = numbered_rows(menu);
    let target = rows
        .iter()
        .position(|(label, _)| {
            label
                .split_whitespace()
                .next()
                .is_some_and(|name| normalized(name) == normalized(model))
        })
        .or_else(|| {
            rows.iter()
                .position(|(label, _)| label.starts_with("All models"))
        })?;
    let accept = if menu
        .lines()
        .any(|line| line.contains("esc") && line.contains("s session"))
    {
        Key::Session
    } else {
        Key::Enter
    };
    navigate(&rows, target, accept)
}

#[derive(Debug)]
struct CursorTarget {
    filter: String,
    effort: Option<String>,
    fast: bool,
    thinking: bool,
}
impl CursorTarget {
    fn new(model: &str) -> Self {
        let mut base = model;
        let fast = base.ends_with("-fast");
        if fast {
            base = base.strip_suffix("-fast").unwrap();
        }
        let effort = ["xhigh", "high", "medium", "low", "max", "none", "minimal"]
            .iter()
            .find_map(|level| {
                base.strip_suffix(&format!("-{level}"))
                    .map(|rest| (rest, (*level).to_string()))
            });
        let effort = effort.map(|(rest, level)| {
            base = rest;
            level
        });
        let thinking = base.ends_with("-thinking");
        if thinking {
            base = base.strip_suffix("-thinking").unwrap();
        }
        Self {
            filter: base.into(),
            effort,
            fast,
            thinking,
        }
    }
}

fn cursor_menu(screen: &str) -> Option<&str> {
    screen
        .rsplit_once("Models matching ")
        .map(|(_, menu)| menu)
        .or_else(|| screen.rsplit_once("Available models").map(|(_, menu)| menu))
        .filter(|menu| menu.contains("filter") && !menu.contains("(no matches)"))
}

fn cursor_parameter_key(screen: &str, target: &CursorTarget) -> Option<Key> {
    let (_, menu) = screen.rsplit_once("— Edit Parameters")?;
    let mut section = "";
    let mut options = Vec::new();
    let mut wanted = Vec::new();
    for line in menu.lines() {
        let text = row_text(line);
        if let Some(glyph) = text.chars().next().filter(|c| "●○◉◯".contains(*c)) {
            let label = text[glyph.len_utf8()..].trim().trim_end_matches('✓').trim();
            let on = matches!(glyph, '●' | '◉');
            let index = options.len();
            options.push((label, selected(line)));
            let level = match normalized(label).as_str() {
                "extrahigh" => "xhigh".into(),
                value => value.to_string(),
            };
            if (section.to_ascii_lowercase().contains("reason")
                || section.to_ascii_lowercase().contains("effort"))
                && target.effort.as_deref() == Some(&level)
                && !on
            {
                wanted.push(index);
            }
            if (label.eq_ignore_ascii_case("Fast") || label.eq_ignore_ascii_case("Fast mode"))
                && on != target.fast
            {
                wanted.push(index);
            }
            if label.eq_ignore_ascii_case("Thinking") && on != target.thinking {
                wanted.push(index);
            }
        } else if !text.is_empty() && !text.contains("esc") {
            section = text;
        }
    }
    if let Some(index) = wanted.first() {
        navigate(&options, *index, Key::Enter)
    } else if !options.is_empty() {
        Some(Key::Escape)
    } else {
        None
    }
}

fn native_confirmation(screen: &str, before: &str, model: &str) -> bool {
    screen.lines().any(|line| {
        let line = line.trim().trim_start_matches(['⎿', '●', '•']).trim();
        let Some(value) = line
            .strip_prefix("Set model to ")
            .or_else(|| line.strip_prefix("Model set to "))
        else {
            return false;
        };
        let matches = value.split_whitespace().any(|token| {
            let token = token.trim_matches(['(', ')', '"']);
            crate::session_model_matches(model, token) || normalized(token) == normalized(model)
        });
        matches
            && screen
                .lines()
                .filter(|l| l.trim().trim_start_matches(['⎿', '●', '•']).trim() == line)
                .count()
                > before
                    .lines()
                    .filter(|l| l.trim().trim_start_matches(['⎿', '●', '•']).trim() == line)
                    .count()
    })
}

fn footer_matches(session: &kode_core::session::Session, label: &str) -> bool {
    if !session.has_empty_model_command_prompt() {
        return false;
    }
    let screen = session.parser.screen();
    let Some((row, _)) = session.model_command_prompt_position() else {
        return false;
    };
    let expected = caption(label);
    screen
        .rows(0, screen.size().1)
        .skip(row as usize + 1)
        .take(4)
        .any(|line| {
            let model = line
                .trim()
                .split(['·', '•'])
                .next()
                .unwrap_or("")
                .split("  ")
                .next()
                .unwrap_or("")
                .trim();
            let actual = caption(model);
            actual == expected
                || ["low", "medium", "high", "xhigh", "max", "ultra", "none"]
                    .iter()
                    .any(|effort| actual == format!("{expected}{effort}"))
        })
}

pub(super) async fn set_pty_model(ctx: &Ctx, id: SessionId, model: &str) -> Result<(), String> {
    let _switching = Switching::acquire(ctx, id)?;
    let (backend, command, before, effort, initial_model) = {
        let sessions = ctx.sessions.lock();
        let session = sessions.get(&id).ok_or("Session not found")?;
        if session.state.status != kode_core::session::state::Status::Idle {
            return Err("Wait for the current turn before switching models".into());
        }
        if !session.has_empty_model_command_prompt() {
            return Err(
                "Clear the desktop input and close any menu before switching models".into(),
            );
        }
        let screen = session.screen_text();
        let effort = screen.lines().rev().find_map(|line| {
            let line = line.trim().trim_matches('│').trim();
            let line = line.strip_prefix("model:").unwrap_or(line).trim();
            let mut words = line.split_whitespace();
            let first = words.next()?;
            (normalized(first) == normalized(&session.state.model))
                .then(|| words.next().unwrap_or("").to_string())
        });
        (
            session.backend_key.clone(),
            session.command.clone(),
            screen,
            effort,
            session.state.model.clone(),
        )
    };
    let codex = matches!(backend.as_str(), "codex" | "tcodex");
    let cursor = backend == "cursor";
    let target = CursorTarget::new(model);
    // The native Cursor footer uses display names, not ids. Read the same
    // installed CLI's catalogue before touching the current prompt.
    let label = if cursor {
        tokio::time::timeout(
            Duration::from_secs(10),
            crate::model_discovery::discover_models(&backend, &command),
        )
        .await
        .map_err(|_| "Cursor model discovery timed out")??
        .models
        .into_iter()
        .find(|m| m.id == model)
        .ok_or("Model is not available in Cursor")?
        .label
    } else {
        model.to_string()
    };
    {
        let sessions = ctx.sessions.lock();
        let session = sessions.get(&id).ok_or("Session not found")?;
        if session.state.status != kode_core::session::state::Status::Idle
            || !session.has_empty_model_command_prompt()
        {
            return Err(
                "Desktop input changed while loading models; retry when it is empty".into(),
            );
        }
    }
    let cursor_label = cursor_base_label(&label);
    let command = if codex {
        "/model".to_string()
    } else if cursor {
        format!("/model {cursor_label}")
    } else {
        format!("/model {model}")
    };
    crate::write_interaction_input(ctx, id, command.as_bytes())?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    let typeahead = cursor
        && ctx
            .sessions
            .lock()
            .get(&id)
            .is_some_and(|s| cursor_menu(&s.screen_text()).is_some());
    if !typeahead {
        crate::write_interaction_input(ctx, id, b"\r")?;
    }
    let mut last_action_screen = String::new();
    let mut edited_parameters = false;
    let mut entered_menu = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let (screen, confirmed) = {
            let sessions = ctx.sessions.lock();
            let session = sessions
                .get(&id)
                .ok_or("Session closed while switching models")?;
            let screen = session.screen_text();
            let confirmed = (session.state.model != initial_model
                && crate::session_model_matches(model, &session.state.model))
                || ((entered_menu || !codex && !cursor)
                    && session.has_empty_model_command_prompt()
                    && (footer_matches(session, &label)
                        || native_confirmation(&screen, &before, model)));
            (screen, confirmed)
        };
        if confirmed {
            if let Some(session) = ctx.sessions.lock().get_mut(&id) {
                session.state.model = model.into();
            }
            ctx.bus
                .emit(EventEnvelope::new(id, "meta", json!({"model":model})));
            return Ok(());
        }
        if screen == last_action_screen {
            continue;
        }
        let key = if codex {
            codex_key(&screen, model, effort.as_deref())
        } else if cursor && screen.contains("— Edit Parameters") {
            let key = cursor_parameter_key(&screen, &target);
            if key == Some(Key::Escape) {
                edited_parameters = true;
            }
            key
        } else if cursor {
            cursor_menu(&screen).and_then(|menu| {
                let row = menu.lines().find(|line| selected(line))?;
                let row = row_text(row);
                // A filter may match more than one model. Never accept a row
                // without checking its model name against the requested id.
                let base = normalized(
                    target
                        .filter
                        .strip_prefix("cursor-")
                        .unwrap_or(&target.filter),
                );
                if !caption(row).starts_with(&base)
                    && !caption(row).starts_with(&caption(&cursor_label))
                {
                    return None;
                }
                if !edited_parameters && row.contains("Tab to modify") {
                    Some(Key::Tab)
                } else {
                    Some(Key::Enter)
                }
            })
        } else {
            None
        };
        if let Some(key) = key {
            entered_menu = true;
            // Recheck the exact screen under the session lock before writing.
            let sessions = ctx.sessions.lock();
            let session = sessions
                .get(&id)
                .ok_or("Session closed while switching models")?;
            if session.screen_text() != screen {
                continue;
            }
            let writer = session.pty.as_ref().ok_or("Session terminal unavailable")?;
            use std::io::Write;
            let mut writer = writer.writer.lock().map_err(|e| e.to_string())?;
            writer
                .write_all(key.bytes())
                .and_then(|_| writer.flush())
                .map_err(|e| e.to_string())?;
            last_action_screen = screen;
        }
    }
    Err("Model change was not confirmed. Check the desktop model menu before retrying.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_requires_native_menu_and_exact_model() {
        assert_eq!(codex_key("› draft gpt-6-astra", "gpt-6-astra", None), None);
        let menu = "Select Model and Effort\n› 1. GPT–6.1–Sol (current) Workhorse\n  2. GPT–6–Astra Frontier\nenter select · esc back";
        assert_eq!(codex_key(menu, "gpt-6-astra", None), Some(Key::Down));
        assert_eq!(codex_key(menu, "gpt-6", None), None);
        assert_eq!(
            codex_key(
                &menu.replace("› 1.", "  1.").replace("  2.", "› 2."),
                "gpt-6-astra",
                None
            ),
            Some(Key::Enter)
        );
    }
    #[test]
    fn reasoning_preserves_effort_and_prefers_session_scope() {
        let menu = "Select Reasoning Level for GPT–6–Astra\n  1. Low\n› 2. Medium (default)\nenter default · s session · esc back";
        assert_eq!(codex_key(menu, "gpt-6-astra", Some("low")), Some(Key::Up));
        assert_eq!(codex_key(menu, "gpt-6-astra", None), Some(Key::Session));
    }
    #[test]
    fn cursor_variants_and_parameters() {
        let target = CursorTarget::new("grok-4.7-high-fast");
        assert_eq!(target.filter, "grok-4.7");
        let menu = "Grok 4.7 — Edit Parameters\nReasoning\n→ ● Low ✓\n  ○ High\n  ◯ Fast\nesc back";
        assert_eq!(cursor_parameter_key(menu, &target), Some(Key::Down));
        assert_eq!(caption("Grok 4.7 256K High"), caption("Grok 4.7 High"));
        assert_eq!(cursor_base_label("Codex 5.3 Extra High Fast"), "Codex 5.3");
        assert_eq!(
            cursor_base_label("Claude Opus 5.5 1M High"),
            "Claude Opus 5.5"
        );
    }
    #[test]
    fn rejects_stale_and_different_confirmations() {
        let line = "⎿ Set model to sonnet";
        assert!(native_confirmation(line, "", "sonnet"));
        assert!(!native_confirmation(line, line, "sonnet"));
        assert!(!native_confirmation(line, "", "opus"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_switch_waits_for_picker_effort_and_native_confirmation() {
        use kode_core::{config::Config, pty::PtyHost, session::Session};
        use portable_pty::PtySize;
        use std::path::Path;
        let ctx = crate::build_test_ctx(Config::default(), "test".into());
        let script = r#"
import os, tty, time
tty.setraw(0)
def show(s):
    os.write(1, ('\x1b[2J\x1b[H'+s).encode())
def key():
    b=os.read(0,1)
    return b+os.read(0,2) if b==b'\x1b' else b
time.sleep(.1)
show('› \x1b[2mAsk Codex to do anything\x1b[0m\r\nGPT–6.1–Sol low\x1b[1;3H')
command=b''
while not command.endswith(b'\r'): command+=os.read(0,1)
assert command==b'/model\r', command
show('Select Model and Effort\r\n› 1. GPT–6.1–Sol (current)\r\n  2. GPT–6–Astra\r\nenter select · esc back')
assert key()==b'\x1b[B'
show('Select Model and Effort\r\n  1. GPT–6.1–Sol (current)\r\n› 2. GPT–6–Astra\r\nenter select · esc back')
assert key()==b'\r'
show('Select Reasoning Level for GPT–6–Astra\r\n  1. Low\r\n› 2. Medium (default)\r\nenter default · s session · esc back')
assert key()==b'\x1b[A'
show('Select Reasoning Level for GPT–6–Astra\r\n› 1. Low\r\n  2. Medium (default)\r\nenter default · s session · esc back')
assert key()==b's'
show('› \x1b[2mAsk Codex to do anything\x1b[0m\r\nGPT–6–Astra low\x1b[1;3H')
time.sleep(10)
"#;
        let mut session = Session::structured(
            991,
            "tcodex",
            "tcodex",
            Path::new("/tmp"),
            "test".into(),
            "gpt-6.1-sol".into(),
        );
        session.pty = Some(
            PtyHost::spawn(
                991,
                "/usr/bin/python3",
                &["-c".into(), script.into()],
                PtySize {
                    rows: 24,
                    cols: 100,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                Path::new("/tmp"),
                ctx.core_tx.clone(),
                &[],
            )
            .unwrap(),
        );
        ctx.sessions.lock().insert(991, session);
        for _ in 0..50 {
            if ctx
                .sessions
                .lock()
                .get(&991)
                .unwrap()
                .has_empty_model_command_prompt()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        ctx.sessions.lock().get_mut(&991).unwrap().state.status =
            kode_core::session::state::Status::Idle;
        let result = crate::set_session_model(&ctx, 991, "gpt-6-astra").await;
        let model = ctx.sessions.lock().get(&991).unwrap().state.model.clone();
        if let Some(session) = ctx.sessions.lock().remove(&991) {
            if let Some(pty) = session.pty {
                let _ = pty.killer.lock().unwrap().kill();
            }
        }
        assert_eq!(result, Ok(()));
        assert_eq!(model, "gpt-6-astra");
    }
}
