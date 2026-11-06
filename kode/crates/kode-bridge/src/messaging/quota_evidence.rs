//! Per-window affirmative evidence survives missing/partial snapshots. No TTL-implied refill.
use super::quota::Sample;
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
pub(super) fn observe(db: &Connection, sample: &Sample, strict: bool) -> Result<()> {
    for bucket in &sample.buckets {
        for window in &bucket.windows {
            let Some(mut percent) = window.used_percent else {
                continue;
            };
            let mut reset = window.resets_at_ms;
            let old:Option<(u64,f64,Option<u64>)>=db.query_row("SELECT observed_at,used_percent,resets_at FROM quota_window_evidence WHERE host=?1 AND profile=?2 AND binding_revision=?3 AND limit_id=?4 AND window_id=?5",params![sample.host,sample.profile,sample.binding_revision,bucket.limit_id,window.window_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((at, prior, prior_reset)) = old {
                if at > bucket.observed_at_ms {
                    continue;
                }
                if at == bucket.observed_at_ms {
                    if prior == percent && prior_reset == reset {
                        continue;
                    }
                    if strict {
                        bail!("conflicting quota window evidence at the same timestamp")
                    }
                    // Historical equal-time conflicts cannot prove that exhaustion cleared.
                    percent = percent.max(prior);
                    reset = match (reset, prior_reset) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        _ => None,
                    };
                }
            }
            db.execute("INSERT INTO quota_window_evidence(host,profile,binding_revision,account_id,account_epoch,limit_id,window_id,observed_at,used_percent,resets_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(host,profile,binding_revision,limit_id,window_id) DO UPDATE SET observed_at=excluded.observed_at,used_percent=excluded.used_percent,resets_at=excluded.resets_at",params![sample.host,sample.profile,sample.binding_revision,sample.account_id,sample.account_epoch,bucket.limit_id,window.window_id,bucket.observed_at_ms,percent,reset])?;
        }
    }
    Ok(())
}
pub(super) fn exhausted(
    db: &Connection,
    host: &str,
    profile: &str,
    revision: u64,
    limit: &str,
    at: u64,
) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM quota_window_evidence WHERE host=?1 AND profile=?2 AND binding_revision=?3 AND limit_id=?4 AND used_percent=100 AND (resets_at IS NULL OR resets_at>?5))",params![host,profile,revision,limit,at],|r|r.get(0))?)
}
pub(super) fn view(
    db: &Connection,
    host: &str,
    profile: &str,
    revision: u64,
    at: u64,
) -> Result<Value> {
    let mut query=db.prepare("SELECT limit_id,window_id,observed_at,resets_at FROM quota_window_evidence WHERE host=?1 AND profile=?2 AND binding_revision=?3 AND used_percent=100 AND (resets_at IS NULL OR resets_at>?4) ORDER BY limit_id,window_id LIMIT 129")?;
    let mut rows=query.query_map(params![host,profile,revision,at],|r|Ok(json!({"limit_id":r.get::<_,String>(0)?,"window_id":r.get::<_,String>(1)?,"observed_at_ms":r.get::<_,u64>(2)?,"resets_at_ms":r.get::<_,Option<u64>>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let truncated = rows.len() > 128;
    rows.truncate(128);
    Ok(json!({"windows":rows,"truncated":truncated}))
}
pub(super) fn backfill(db: &Connection) -> Result<()> {
    // Replay audit, not just the last snapshot, which may already have lost a window.
    let mut events=db.prepare("SELECT json_extract(body,'$.sample') FROM resource_events WHERE json_extract(body,'$.kind')='quota_observed' ORDER BY seq")?;
    for body in events.query_map([], |r| r.get::<_, String>(0))? {
        observe(db, &serde_json::from_str(&body?)?, false)?;
    }
    let mut snapshots = db.prepare("SELECT body FROM quota_snapshots")?;
    for body in snapshots.query_map([], |r| r.get::<_, String>(0))? {
        observe(db, &serde_json::from_str(&body?)?, false)?;
    }
    Ok(())
}
