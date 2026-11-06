//! Bounded model-facing projections; the durable message is never truncated.
use anyhow::{bail, Result};
use serde_json::{json, Value};
pub(super) fn preview(message: Value) -> Value {
    preview_limit(message, 1024)
}
fn preview_limit(mut message: Value, limit: usize) -> Value {
    let text = message["content"].as_str().unwrap_or_default();
    let length = text.chars().count();
    if length > limit {
        let prefix: String = text.chars().take(limit).collect();
        message["content"] = json!(prefix);
        message["content_truncated"] = json!(true);
        message["content_length"] = json!(length);
        message["continuation"] =
            json!({"tool":"kode_sessions_message_read","message_id":message["id"],"offset":limit});
    }
    message
}
const PAGE_TOKEN_BUDGET: usize = 8192;
// Conservative fallback for byte-backed tokenizers; not model usage or framing.
fn budget() -> Value {
    json!({"limit":PAGE_TOKEN_BUDGET,"accounting":"serialized_utf8_bytes","exact_tokens":false})
}
fn fits(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|v| v.len() <= PAGE_TOKEN_BUDGET)
}
pub(super) fn events(result: Value, after: u64) -> Result<Value> {
    let rows = result["events"].as_array().cloned().unwrap_or_default();
    let mut page = json!({"events":[],"cursor":after,"may_have_more":!rows.is_empty(),"token_budget":budget()});
    for mut row in rows {
        if page["events"].as_array().unwrap().len() >= 16 {
            break;
        }
        let original = row["message"].take();
        row["message"] = preview(original.clone());
        let mut candidate = page.clone();
        candidate["cursor"] = row["seq"].clone();
        candidate["events"].as_array_mut().unwrap().push(row);
        if !fits(&candidate) {
            if page["events"].as_array().unwrap().is_empty() {
                let mut limit = 1024;
                while !fits(&candidate) && limit > 0 {
                    limit /= 2;
                    candidate["events"][0]["message"] = preview_limit(original.clone(), limit);
                }
                if !fits(&candidate) {
                    bail!("Event metadata exceeds page token estimate budget; cursor unchanged")
                }
                return Ok(candidate);
            }
            break;
        }
        page = candidate;
    }
    Ok(page)
}
pub(super) fn message(message: Value, offset: u64) -> Result<Value> {
    let points: Vec<char> = message["content"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .collect();
    let offset = usize::try_from(offset)?;
    if offset > points.len() {
        bail!("Offset exceeds message length")
    }
    let build = |end: usize| {
        let text: String = points[offset..end].iter().collect();
        json!({"id":message["id"],"source":message["source"],"target":message["target"],"in_reply_to":message["in_reply_to"],"status":message["status"],"content":text,"offset":offset,"next":if end<points.len(){Some(end)}else{None},"content_length":points.len(),"token_budget":budget()})
    };
    let mut low = offset;
    let mut high = offset.saturating_add(4096).min(points.len());
    if !fits(&build(low)) {
        bail!("Message metadata exceeds page token estimate budget")
    }
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if fits(&build(mid)) {
            low = mid
        } else {
            high = mid - 1
        }
    }
    if low == offset && offset < points.len() {
        bail!("Message metadata leaves no content budget")
    }
    Ok(build(low))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_event_preview_shrinks_without_skipping_or_losing_continuation() {
        let original =
            json!({"id":"fixture","content":"\0中🦊".repeat(3000),"detail":"x".repeat(7000)});
        let page = events(json!({"events":[{"seq":5,"message":original}]}), 4).unwrap();
        assert!(fits(&page));
        assert_eq!(page["cursor"], 5);
        let mut offset = page["events"][0]["message"]["continuation"]["offset"]
            .as_u64()
            .unwrap();
        assert!(offset < 1024);
        let mut restored = page["events"][0]["message"]["content"]
            .as_str()
            .unwrap()
            .to_owned();
        loop {
            let next = message(original.clone(), offset).unwrap();
            assert!(fits(&next));
            restored.push_str(next["content"].as_str().unwrap());
            match next["next"].as_u64() {
                Some(value) => {
                    assert!(value > offset);
                    offset = value
                }
                None => break,
            }
        }
        assert_eq!(restored, original["content"].as_str().unwrap());
        let mut oversized = original;
        oversized["detail"] = json!("x".repeat(9000));
        assert!(events(json!({"events":[{"seq":5,"message":oversized}]}), 4)
            .unwrap_err()
            .to_string()
            .contains("cursor unchanged"));
        oversized["id"] = json!("x".repeat(9000));
        assert!(message(oversized, 0).is_err());
    }
}

/// Audit records preserve complete evidence and have their own cursor domain.
pub(super) fn lifecycle(result: Value, after: u64) -> Result<Value> {
    let rows = result["events"].as_array().cloned().unwrap_or_default();
    let mut page = json!({"events":[],"cursor":after,"may_have_more":!rows.is_empty(),"token_budget":budget()});
    for row in rows {
        if page["events"].as_array().unwrap().len() >= 16 {
            break;
        }
        let mut candidate = page.clone();
        candidate["cursor"] = row["seq"].clone();
        candidate["events"].as_array_mut().unwrap().push(row);
        if !fits(&candidate) {
            if page["events"].as_array().unwrap().is_empty() {
                bail!("Audit record exceeds page token estimate budget; cursor unchanged")
            }
            break;
        }
        page = candidate;
    }
    Ok(page)
}
