//! Detection for processes that were launched by Kode.
//!
//! MCP and hook registrations live in backend user configuration for compatibility,
//! so presence in that configuration is not proof that the current CLI belongs to
//! Kode. Kode's session launcher supplies both values below to the owned process.

/// True when the current process belongs to a Kode-managed CLI session.
pub fn is_active(expected_backend: Option<&str>) -> bool {
    is_active_values(
        std::env::var("KODE_HOST").ok().as_deref(),
        std::env::var("KODE_SESSION_ID").ok().as_deref(),
        std::env::var("KODE_BACKEND_KEY").ok().as_deref(),
        expected_backend,
    )
}

fn is_active_values(
    host: Option<&str>,
    session_id: Option<&str>,
    backend_key: Option<&str>,
    expected_backend: Option<&str>,
) -> bool {
    if host != Some("1") {
        return false;
    }
    let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) else {
        return false;
    };
    let Some(backend_key) = backend_key.filter(|value| !value.trim().is_empty()) else {
        return false;
    };
    let _ = session_id;
    expected_backend.is_none_or(|expected| backend_matches(expected, backend_key))
}

fn backend_matches(expected: &str, actual: &str) -> bool {
    if expected == actual {
        return true;
    }
    match expected {
        "codex" => actual.ends_with("codex"),
        "claude" => matches!(actual, "claude" | "claude-internal" | "tclaude"),
        "codebuddy" => actual.ends_with("codebuddy"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_cli_is_inactive() {
        assert!(!is_active_values(None, None, None, None));
        assert!(!is_active_values(None, Some("42"), Some("codex"), None));
        assert!(!is_active_values(Some("1"), Some("42"), None, None));
    }

    #[test]
    fn kode_session_requires_matching_backend_when_requested() {
        assert!(is_active_values(Some("1"), Some("42"), Some("codex"), None));
        assert!(is_active_values(
            Some("1"),
            Some("42"),
            Some("codex"),
            Some("codex")
        ));
        assert!(!is_active_values(
            Some("1"),
            Some("42"),
            Some("claude"),
            Some("codex")
        ));
        assert!(is_active_values(
            Some("1"),
            Some("42"),
            Some("tcodex"),
            Some("codex")
        ));
        assert!(is_active_values(
            Some("1"),
            Some("42"),
            Some("tclaude"),
            Some("claude")
        ));
        assert!(is_active_values(
            Some("1"),
            Some("42"),
            Some("unknown"),
            None
        ));
        assert!(!is_active_values(
            Some("1"),
            Some("  "),
            Some("codex"),
            None
        ));
    }
}
