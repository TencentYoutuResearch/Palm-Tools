//! Native Codex permission control through its `/permissions` preset menu.
//! Keys go only to the recognised menu, and success requires the reopened
//! menu to mark the requested preset `(current)`.
use crate::model_switch::{navigate, numbered_rows, Key};
use crate::{Ctx, SessionId};
use std::time::Duration;

const MENU: &str = "Update Model Permissions";
const CONFIRM: &str = "Enable full access?";

/// Menu row that applies the requested preset.
fn is_target(row: &str, full_access: bool) -> bool {
    if full_access {
        row.starts_with("Full Access")
    } else {
        row.starts_with("Ask for approval")
    }
}

#[derive(Debug, PartialEq)]
enum Step {
    Press(Key),
    /// The menu reports the target preset as current; close it.
    Done,
    Wait,
}

fn next_step(screen: &str, full_access: bool, chosen: bool) -> Result<Step, String> {
    if let Some((_, dialog)) = screen.rsplit_once(CONFIRM) {
        let rows = numbered_rows(dialog);
        let yes = rows
            .iter()
            .position(|(row, _)| row.starts_with("Yes"))
            .ok_or("Codex full-access confirmation changed; switch on the desktop")?;
        return Ok(navigate(&rows, yes, Key::Enter).map_or(Step::Wait, Step::Press));
    }
    let Some((_, menu)) = screen.rsplit_once(MENU) else {
        return Ok(Step::Wait);
    };
    let rows = numbered_rows(menu);
    if rows.is_empty() {
        // "Loading permission profiles…"
        return Ok(Step::Wait);
    }
    let Some(target) = rows.iter().position(|(row, _)| is_target(row, full_access)) else {
        return Err("Codex permission menu has no matching preset; switch on the desktop".into());
    };
    if rows[target].0.contains("(current)") {
        return Ok(Step::Done);
    }
    if chosen {
        return Err("Codex did not apply the requested permission preset".into());
    }
    Ok(navigate(&rows, target, Key::Enter).map_or(Step::Wait, Step::Press))
}

pub(super) async fn set_codex_permission(
    ctx: &Ctx,
    id: SessionId,
    full_access: bool,
) -> Result<(), String> {
    let result = drive(ctx, id, full_access).await;
    if result.is_err() {
        // Never leave a half-driven menu on the desktop terminal.
        let open = ctx.sessions.lock().get(&id).is_some_and(|s| {
            let screen = s.screen_text();
            screen.contains(MENU) || screen.contains(CONFIRM)
        });
        if open {
            let _ = crate::write_interaction_input(ctx, id, Key::Escape.bytes());
        }
    }
    result
}

async fn drive(ctx: &Ctx, id: SessionId, full_access: bool) -> Result<(), String> {
    {
        let sessions = ctx.sessions.lock();
        let session = sessions.get(&id).ok_or("Session not found")?;
        if session.state.status != kode_core::session::state::Status::Idle {
            return Err("Wait for the current turn before changing permissions".into());
        }
        if !session.has_empty_model_command_prompt() {
            return Err(
                "Clear the desktop input and close any menu before changing permissions".into(),
            );
        }
    }
    let open = |ctx: &Ctx| -> Result<(), String> {
        crate::write_interaction_input(ctx, id, b"/permissions")?;
        Ok(())
    };
    open(ctx)?;
    tokio::time::sleep(Duration::from_millis(350)).await;
    crate::write_interaction_input(ctx, id, b"\r")?;
    // `chosen`: Enter pressed on the target row; verification reopens the menu.
    let (mut chosen, mut reopened, mut closing) = (false, false, false);
    let mut last_screen = String::new();
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let (screen, prompt_empty) = {
            let sessions = ctx.sessions.lock();
            let session = sessions
                .get(&id)
                .ok_or("Session closed while changing permissions")?;
            (session.screen_text(), session.has_empty_model_command_prompt())
        };
        if closing {
            if prompt_empty {
                return Ok(());
            }
            continue;
        }
        let in_dialog = screen.contains(MENU) || screen.contains(CONFIRM);
        if !in_dialog {
            if chosen && !reopened && prompt_empty {
                reopened = true;
                open(ctx)?;
                tokio::time::sleep(Duration::from_millis(350)).await;
                crate::write_interaction_input(ctx, id, b"\r")?;
            }
            continue;
        }
        if screen == last_screen {
            continue;
        }
        match next_step(&screen, full_access, chosen && reopened)? {
            Step::Done => {
                closing = true;
                crate::write_interaction_input(ctx, id, Key::Escape.bytes())?;
            }
            Step::Press(key) => {
                if key == Key::Enter && screen.rsplit_once(CONFIRM).is_none() {
                    chosen = true;
                }
                crate::write_interaction_input(ctx, id, key.bytes())?;
                last_screen = screen;
            }
            Step::Wait => {}
        }
    }
    Err("Timed out waiting for Codex to confirm the permission change".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from codex-cli 0.166 `/permissions`.
    const MENU_SCREEN: &str = "  Update Model Permissions
  1. Ask for approval          Read and edit workspace files and run commands, with approval required for internet
                               access or edits outside the workspace
› 2. Approve for me (current)  Only ask for actions detected as potentially unsafe
  3. Full Access               Use with caution: Codex can edit files outside this workspace and access the internet
                               without approval
  4. Read Only                 Read workspace files, with approval required for edits or internet access
  enter select · esc back";
    const CONFIRM_SCREEN: &str = "                          Enable full access?
› Ask Codex to do anythi  When Codex runs with full access, it can edit any file on your
  GPT-6-Astra low · /pri  Exercise caution when enabling full access. This significantly
                        › 1. Yes, continue anyway  Apply full access for this session
                          2. Cancel                Go back without enabling full access
                          enter select · esc back";

    #[test]
    fn navigates_to_requested_preset_and_confirms_full_access() {
        assert_eq!(next_step(MENU_SCREEN, true, false), Ok(Step::Press(Key::Down)));
        assert_eq!(next_step(MENU_SCREEN, false, false), Ok(Step::Press(Key::Up)));
        let on_full = MENU_SCREEN
            .replace("› 2. Approve", "  2. Approve")
            .replace("  3. Full Access", "› 3. Full Access");
        assert_eq!(next_step(&on_full, true, false), Ok(Step::Press(Key::Enter)));
        assert_eq!(next_step(CONFIRM_SCREEN, true, false), Ok(Step::Press(Key::Enter)));
    }

    #[test]
    fn current_marker_is_the_only_success_signal() {
        let applied = MENU_SCREEN
            .replace("2. Approve for me (current)", "2. Approve for me")
            .replace("3. Full Access   ", "3. Full Access (current)");
        assert_eq!(next_step(&applied, true, true), Ok(Step::Done));
        assert!(next_step(MENU_SCREEN, true, true).is_err());
        assert_eq!(next_step("› Ask Codex to do anything", true, false), Ok(Step::Wait));
        let loading = "  Update Model Permissions\n›    Loading permission profiles…\n  enter select · esc back";
        assert_eq!(next_step(loading, true, false), Ok(Step::Wait));
    }
}
