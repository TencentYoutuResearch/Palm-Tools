//! Low-frequency recovery after optimistic Escape cancellation.

use std::time::{Duration, Instant};

const CHECK_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct BusyRecovery {
    next_check: Option<Instant>,
    checked_revision: u64,
}

impl BusyRecovery {
    pub(super) fn cancelled(&mut self, now: Instant, revision: u64) {
        self.next_check = Some(now + CHECK_INTERVAL);
        self.checked_revision = revision;
    }

    pub(super) fn should_check(&mut self, now: Instant, revision: u64) -> bool {
        if self.next_check.is_some_and(|deadline| now < deadline)
            || self.checked_revision == revision
        {
            return false;
        }
        self.next_check = Some(now + CHECK_INTERVAL);
        self.checked_revision = revision;
        true
    }

    #[cfg(test)]
    pub(super) fn allow_check_for_test(&mut self) {
        self.next_check = None;
    }
}

/// Match the live status footer next to the composer, not arbitrary output.
/// Ordinary animation, a question, or absence of this marker is inconclusive.
pub(super) fn has_running_footer(screen: &str) -> bool {
    let mut composer_seen = false;
    for line in screen.lines().rev().take(8).map(str::trim) {
        if line.starts_with('›') || line.starts_with('❯') {
            composer_seen = true;
            continue;
        }
        if composer_seen
            && line.starts_with(['•', '●', '◦', '·'])
            && line.ends_with("esc to interrupt)")
            && line.contains(" • esc to interrupt)")
            && line.rsplit_once('(').is_some_and(|(_, suffix)| {
                suffix.as_bytes().first().is_some_and(u8::is_ascii_digit)
            })
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_requires_grace_period_and_new_output() {
        let now = Instant::now();
        let mut recovery = BusyRecovery::default();
        recovery.cancelled(now, 10);
        assert!(!recovery.should_check(now + Duration::from_secs(1), 11));
        assert!(!recovery.should_check(now + CHECK_INTERVAL, 10));
        assert!(recovery.should_check(now + CHECK_INTERVAL, 11));
        assert!(!recovery.should_check(now + Duration::from_secs(3), 12));
        assert!(recovery.should_check(now + Duration::from_secs(4), 12));
        assert!(!recovery.should_check(now + Duration::from_secs(30), 12));
    }

    #[test]
    fn recovery_requires_running_footer_next_to_composer() {
        assert!(has_running_footer(
            "tool output\n• Working (1m 42s • esc to interrupt)\n\n› Ask Codex to do anything\nGPT-6"
        ));
        for screen in [
            "• idle animation\n› Ask Codex to do anything",
            "• Working (1s • esc to interrupt)\nquestion options",
            "› Ask Codex to do anything\n• Working (1s • esc to interrupt)",
            "printed text: Working (1s • esc to interrupt)\n› Ask Codex to do anything",
            "• Working (1s • esc to interrupt)\n1\n2\n3\n4\n5\n6\n7\n8\n› Ask Codex",
            "• Interrupted\n› Ask Codex to do anything",
        ] {
            assert!(!has_running_footer(screen), "{screen}");
        }
    }
}
