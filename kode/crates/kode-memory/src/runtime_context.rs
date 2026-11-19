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

/// Return the actual backend only for a Kode-owned session in one of the families.
pub fn active_backend_for(families: &[&str]) -> Option<String> {
    active_backend_for_values(
        std::env::var("KODE_HOST").ok().as_deref(),
        std::env::var("KODE_SESSION_ID").ok().as_deref(),
        std::env::var("KODE_BACKEND_KEY").ok().as_deref(),
        families,
    )
    .map(str::to_owned)
}

pub(crate) fn active_backend_for_values<'a>(
    host: Option<&str>,
    session_id: Option<&str>,
    backend_key: Option<&'a str>,
    families: &[&str],
) -> Option<&'a str> {
    if !is_active_values(host, session_id, backend_key, None) {
        return None;
    }
    backend_key.filter(|backend| {
        families
            .iter()
            .any(|family| backend_matches(family, backend))
    })
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

/// Backend keys belong to a CLI family by case-insensitive suffix, so wrappers
/// (`tcodex`, `tclaude`) and shared Agent keys (`builtin-codex`) need no list.
pub fn backend_matches(family: &str, key: &str) -> bool {
    let family = family.trim().to_ascii_lowercase();
    let key = key.trim().to_ascii_lowercase();
    !family.is_empty()
        && (key.ends_with(&family) || (family == "claude" && key.ends_with("claude-internal")))
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
    fn family_detection_preserves_backend_identity_and_requires_ownership() {
        let allowed = &["codex"];
        for backend in ["codex", "tcodex"] {
            assert_eq!(
                active_backend_for_values(Some("1"), Some("42"), Some(backend), allowed),
                Some(backend)
            );
            assert_eq!(
                active_backend_for_values(None, Some("42"), Some(backend), allowed),
                None
            );
            assert_eq!(
                active_backend_for_values(Some("1"), Some(" "), Some(backend), allowed),
                None
            );
        }
        for backend in ["builtin-codex", "custom-codex", "Codex"] {
            assert_eq!(
                active_backend_for_values(Some("1"), Some("42"), Some(backend), allowed),
                Some(backend)
            );
        }
        for backend in ["claude", "codex-wrapper", "unknown", " "] {
            assert_eq!(
                active_backend_for_values(Some("1"), Some("42"), Some(backend), allowed),
                None
            );
        }
        // Family-level checks accept tcodex while the allowlist above returns
        // its exact identity for authorship and independent hook storage.
        assert!(is_active_values(
            Some("1"),
            Some("42"),
            Some("tcodex"),
            Some("codex")
        ));
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

/// Whether this GUI backend has migrated from the legacy memory-only MCP to
/// Kode's session-scoped backend services. Other CLI hosts stay unaffected.
pub fn uses_shared_services(backend:&str)->bool {
    let path=std::env::var_os("KODE_WORKBENCH_CONNECTION").and_then(|path|std::path::PathBuf::from(path).parent().map(|root|root.join("shared-mcp.json"))).or_else(||dirs::config_dir().map(|root|root.join("kode/shared-mcp.json")));
    let Some(path)=path else {return false};
    std::fs::read(path).ok().and_then(|bytes|serde_json::from_slice::<serde_json::Value>(&bytes).ok()).is_some_and(|value|value["backends"].as_array().is_some_and(|rows|rows.iter().any(|row|row.as_str()==Some(backend))))
}
