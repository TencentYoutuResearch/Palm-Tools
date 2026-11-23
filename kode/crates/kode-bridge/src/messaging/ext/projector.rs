//! Turns the runtime log's low-level status flips into turn lifecycle events.
//! Pure state machine: the gateway feeds it durable events and persists what
//! it returns.
use crate::EventEnvelope;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Status ticks and jsonl tails both flip Busy→Idle→Busy within one turn;
/// a turn only completes once the session stays idle this long.
pub const COMPLETION_GRACE: Duration = Duration::from_millis(1500);
const SUMMARY_CHARS: usize = 500;

#[derive(Default)]
struct Session {
    turn: Option<String>,
    pending: Option<(Instant, String)>,
}

pub struct Projector {
    grace: Duration,
    sessions: HashMap<u64, Session>,
    exited: HashSet<u64>,
}

pub type Derived = (u64, &'static str, Value);

impl Projector {
    pub fn new(grace: Duration) -> Self {
        Self {
            grace,
            sessions: HashMap::new(),
            exited: HashSet::new(),
        }
    }

    pub fn feed(&mut self, event: &EventEnvelope, now: Instant) -> Vec<Derived> {
        let id = event.session_id;
        let session = self.sessions.entry(id).or_default();
        let mut out = vec![];
        match event.r#type.as_str() {
            "session.status" => match event.payload["status"].as_str().unwrap_or_default() {
                "busy" => {
                    if let Some((_, turn)) = session.pending.take() {
                        // Same turn resumed inside the grace window.
                        session.turn = Some(turn);
                    } else if session.turn.is_none() {
                        let turn = format!("{id}:{}", event.ts);
                        out.push((id, "session.turn_started", json!({"turn_id":turn})));
                        session.turn = Some(turn);
                    }
                }
                "idle" => {
                    if let Some(turn) = session.turn.take() {
                        session.pending = Some((now + self.grace, turn));
                    }
                }
                "exited" => out.extend(self.exit(id)),
                _ => {}
            },
            "ask_user_question" | "plan_proposed" => out.push((
                id,
                "session.awaiting",
                json!({
                    "kind": if event.r#type == "plan_proposed" { "plan" } else { "question" },
                    "turn_id": session.turn,
                    "summary": summary(&event.payload),
                }),
            )),
            "interaction.resolved" | "session.attention_cleared" => {
                out.push((
                    id,
                    "session.awaiting_cleared",
                    json!({"turn_id":session.turn}),
                ));
            }
            _ => {}
        }
        out
    }

    /// The session left the runtime: an open turn ends without a final answer.
    pub fn exit(&mut self, id: u64) -> Vec<Derived> {
        if !self.exited.insert(id) {
            return vec![];
        }
        let session = self.sessions.entry(id).or_default();
        let mut out = vec![];
        if let Some(turn) = session
            .turn
            .take()
            .or_else(|| session.pending.take().map(|(_, t)| t))
        {
            out.push((
                id,
                "session.turn_completed",
                json!({"turn_id":turn,"outcome":"exited"}),
            ));
        }
        out.push((id, "session.exited", json!({})));
        out
    }

    /// Turns whose grace window has elapsed: `(session, turn_id)`.
    pub fn due(&mut self, now: Instant) -> Vec<(u64, String)> {
        let mut done = vec![];
        for (id, session) in &mut self.sessions {
            if session.pending.as_ref().is_some_and(|(at, _)| *at <= now) {
                let (_, turn) = session.pending.take().unwrap();
                done.push((*id, turn));
            }
        }
        done.sort();
        done
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        self.sessions
            .values()
            .filter_map(|s| s.pending.as_ref().map(|(at, _)| *at))
            .min()
    }
}

fn summary(payload: &Value) -> String {
    let text = ["question", "text", "plan", "title"]
        .iter()
        .find_map(|key| payload[*key].as_str())
        .map(str::to_owned)
        .or_else(|| {
            payload["questions"][0]["question"]
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_default();
    text.chars().take(SUMMARY_CHARS).collect()
}

/// The newest finished assistant message, bounded for event payloads.
pub fn final_message(history: &[EventEnvelope], max_chars: usize) -> Value {
    history
        .iter()
        .rev()
        .filter(|e| e.r#type == "message")
        .find(|e| {
            e.payload["role"] == "assistant"
                && e.payload["streaming"] != true
                && e.payload["text"]
                    .as_str()
                    .is_some_and(|t| !t.trim().is_empty())
        })
        .map(|e| {
            let text = e.payload["text"].as_str().unwrap_or_default();
            let count = text.chars().count();
            json!({
                "id": e.payload["id"],
                "cursor": e.ts,
                "text": text.chars().take(max_chars).collect::<String>(),
                "truncated": count > max_chars,
            })
        })
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(id: u64, ts: u64, status: &str) -> EventEnvelope {
        let mut event = EventEnvelope::new(id, "session.status", json!({"status":status}));
        event.ts = ts;
        event
    }

    #[test]
    fn idle_flicker_inside_the_grace_window_stays_one_turn() {
        let mut p = Projector::new(Duration::from_millis(100));
        let t0 = Instant::now();
        let started = p.feed(&status(7, 1, "busy"), t0);
        assert_eq!(started[0].1, "session.turn_started");
        assert!(p.feed(&status(7, 2, "idle"), t0).is_empty());
        assert!(
            p.feed(&status(7, 3, "busy"), t0).is_empty(),
            "resumed turn is not a new turn"
        );
        assert!(p.feed(&status(7, 4, "idle"), t0).is_empty());
        assert!(p.due(t0).is_empty());
        let done = p.due(t0 + Duration::from_millis(150));
        assert_eq!(
            done,
            vec![(7, started[0].2["turn_id"].as_str().unwrap().to_owned())]
        );
        assert!(p.next_deadline().is_none());
        let next = p.feed(&status(7, 5, "busy"), t0 + Duration::from_millis(200));
        assert_eq!(next[0].1, "session.turn_started");
        assert_ne!(next[0].2["turn_id"], started[0].2["turn_id"]);
    }

    #[test]
    fn idle_without_a_known_turn_and_repeated_exit_emit_nothing_extra() {
        let mut p = Projector::new(Duration::ZERO);
        let now = Instant::now();
        assert!(p.feed(&status(1, 1, "idle"), now).is_empty());
        p.feed(&status(1, 2, "busy"), now);
        let exited = p.exit(1);
        assert_eq!(
            exited.iter().map(|e| e.1).collect::<Vec<_>>(),
            ["session.turn_completed", "session.exited"]
        );
        assert_eq!(exited[0].2["outcome"], "exited");
        assert!(p.exit(1).is_empty());
    }

    #[test]
    fn final_message_skips_streaming_and_user_text_and_bounds_length() {
        let history: Vec<_> = [
            json!({"id":"a","role":"assistant","text":"done ✓"}),
            json!({"id":"b","role":"assistant","text":"partial","streaming":true}),
            json!({"id":"c","role":"user","text":"thanks"}),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            let mut e = EventEnvelope::new(1, "message", p);
            e.ts = i as u64 + 1;
            e
        })
        .collect();
        let message = final_message(&history, 4);
        assert_eq!(message["id"], "a");
        assert_eq!(message["text"], "done");
        assert_eq!(message["truncated"], true);
        assert!(final_message(&history[1..], 10).is_null());
    }

    #[test]
    fn questions_and_plans_surface_as_awaiting_with_a_bounded_summary() {
        let mut p = Projector::new(Duration::ZERO);
        let long = "q".repeat(SUMMARY_CHARS + 10);
        let event = EventEnvelope::new(
            3,
            "ask_user_question",
            json!({"questions":[{"question":long}]}),
        );
        let out = p.feed(&event, Instant::now());
        assert_eq!(out[0].1, "session.awaiting");
        assert_eq!(out[0].2["kind"], "question");
        assert_eq!(out[0].2["summary"].as_str().unwrap().len(), SUMMARY_CHARS);
    }
}
