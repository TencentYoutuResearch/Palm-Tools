//! Resolve light/dark for PTY child env (`TERM_THEME` / `COLORFGBG`).
//!
//! Frontend usually passes the live xterm theme on spawn. This module is the
//! fallback when the hint is missing (restore paths, older clients, shell PTY).

use kode_core::pty::{parse_term_theme, terminal_theme_env};

pub fn resolve_terminal_dark(explicit: Option<&str>) -> bool {
    if let Some(v) = parse_term_theme(explicit) {
        return v;
    }
    match crate::persistence::load().theme.as_deref() {
        Some("light") => false,
        Some("dark") => true,
        _ => system_prefers_dark(),
    }
}

pub fn theme_env(explicit: Option<&str>) -> Vec<(String, String)> {
    terminal_theme_env(resolve_terminal_dark(explicit))
}

fn system_prefers_dark() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().eq_ignore_ascii_case("Dark"))
            .unwrap_or(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_hint_wins() {
        assert!(!resolve_terminal_dark(Some("light")));
        assert!(resolve_terminal_dark(Some("DARK")));
    }
}
