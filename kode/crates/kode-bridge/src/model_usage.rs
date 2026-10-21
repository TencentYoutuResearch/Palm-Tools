//! Aggregate CLI/model token history on the machine running this bridge.
//!
//! 扫描哪些目录、怎么解析 usage,由 `kode_core::session::backend::BackendProfile`
//! 决定。这里做缓存、时间窗过滤和聚合。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone};
use kode_core::session::backend::{self, UsageBucket, UsageEvent};
use serde::{Deserialize, Serialize};
const MAX_HISTORY_FILES: usize = 50_000;
const DAILY_HISTORY_DAYS: i64 = 84;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelUsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageRow {
    #[serde(default)]
    pub source: String,
    pub backend: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub requests: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageSnapshot {
    pub period: String,
    pub scanned_files: usize,
    pub rows: Vec<ModelUsageRow>,
    pub totals: ModelUsageTotals,
    pub daily: Vec<ModelUsageDay>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsageDay {
    pub date: String,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileFingerprint {
    len: u64,
    modified_ns: Option<u128>,
}

impl FileFingerprint {
    fn modified_ms(self) -> Option<i64> {
        self.modified_ns
            .map(|value| (value / 1_000_000).min(i64::MAX as u128) as i64)
    }
}

#[derive(Debug)]
struct CachedHistoryFile {
    backend: String,
    fingerprint: FileFingerprint,
    events: Vec<UsageEvent>,
}

#[derive(Debug, Default)]
struct HistoryCache {
    files: HashMap<PathBuf, CachedHistoryFile>,
}

type UsageMap = HashMap<(String, String), UsageBucket>;
type DailyMap = HashMap<String, u64>;

fn history_cache() -> &'static Mutex<HistoryCache> {
    static CACHE: OnceLock<Mutex<HistoryCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HistoryCache::default()))
}

#[derive(Debug, Deserialize)]
pub struct ModelUsageQuery {
    pub period: String,
    pub since_ms: Option<i64>,
    pub timezone_offset_minutes: Option<i32>,
}

pub fn normalize_period(period: &str) -> Result<&'static str, String> {
    match period {
        "today" => Ok("today"),
        "month" => Ok("month"),
        "all" => Ok("all"),
        _ => Err(format!("unsupported model usage period: {period}")),
    }
}

pub fn period_start_ms(period: &str) -> Option<i64> {
    let now = Local::now();
    let date = now.date_naive();
    let start = match period {
        "today" => date.and_hms_opt(0, 0, 0)?,
        "month" => date.with_day(1)?.and_hms_opt(0, 0, 0)?,
        _ => return None,
    };
    Local
        .from_local_datetime(&start)
        .earliest()
        .map(|value| value.timestamp_millis())
}

fn display_today(offset_minutes: Option<i32>) -> chrono::NaiveDate {
    offset_minutes
        .and_then(|minutes| chrono::FixedOffset::east_opt(minutes * 60))
        .map(|offset| chrono::Utc::now().with_timezone(&offset).date_naive())
        .unwrap_or_else(|| Local::now().date_naive())
}

fn daily_history_start_ms(offset_minutes: Option<i32>) -> i64 {
    let date = display_today(offset_minutes) - ChronoDuration::days(DAILY_HISTORY_DAYS - 1);
    let start = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    offset_minutes
        .and_then(|minutes| chrono::FixedOffset::east_opt(minutes * 60))
        .and_then(|offset| offset.from_local_datetime(&start).single())
        .map(|time| time.timestamp_millis())
        .or_else(|| {
            Local
                .from_local_datetime(&start)
                .earliest()
                .map(|time| time.timestamp_millis())
        })
        .expect("local midnight exists")
}

pub fn collect_snapshot(
    period: &str,
    since_override: Option<i64>,
    timezone_offset_minutes: Option<i32>,
) -> Result<ModelUsageSnapshot, String> {
    normalize_period(period)?;
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    let since_ms = since_override.or_else(|| period_start_ms(period));
    let history_since_ms = daily_history_start_ms(timezone_offset_minutes);
    let file_since_ms = since_ms.map(|since| since.min(history_since_ms));
    let mut usage = UsageMap::new();
    let mut daily = DailyMap::new();
    let mut scanned_files = 0usize;
    let mut considered_files = 0usize;
    let mut seen_paths = HashSet::new();
    let mut history = history_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    for profile in backend::all_profiles() {
        for root in profile.usage_roots(&home) {
            let mut files = Vec::new();
            collect_jsonl_files(&root, 0, &mut files);
            for path in files {
                if considered_files >= MAX_HISTORY_FILES {
                    break;
                }
                if !profile.usage_file_matches(&path) {
                    continue;
                }
                considered_files += 1;
                seen_paths.insert(path.clone());

                let Some(fingerprint) = file_fingerprint(&path) else {
                    continue;
                };
                if !file_can_overlap(fingerprint, file_since_ms) {
                    continue;
                }
                scanned_files += 1;

                refresh_history_file(&mut history, &path, *profile, fingerprint);
                if let Some(cached) = history.files.get(&path) {
                    for event in &cached.events {
                        aggregate_event(
                            event,
                            since_ms,
                            history_since_ms,
                            timezone_offset_minutes,
                            &mut usage,
                            &mut daily,
                        );
                    }
                }
            }
            if considered_files >= MAX_HISTORY_FILES {
                break;
            }
        }
        if considered_files >= MAX_HISTORY_FILES {
            break;
        }
    }

    history.files.retain(|path, _| seen_paths.contains(path));

    Ok(finish_snapshot(
        period,
        scanned_files,
        usage,
        daily,
        timezone_offset_minutes,
    ))
}

fn collect_jsonl_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 8 || out.len() >= MAX_HISTORY_FILES || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_jsonl_files(&path, depth + 1, out);
        } else if file_type.is_file()
            && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        {
            out.push(path);
        }
        if out.len() >= MAX_HISTORY_FILES {
            break;
        }
    }
}

fn file_can_overlap(fingerprint: FileFingerprint, since_ms: Option<i64>) -> bool {
    let Some(since) = since_ms else {
        return true;
    };
    fingerprint
        .modified_ms()
        .is_none_or(|modified| modified >= since)
}

fn file_fingerprint(path: &Path) -> Option<FileFingerprint> {
    let metadata = path.metadata().ok()?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    Some(FileFingerprint {
        len: metadata.len(),
        modified_ns,
    })
}

fn refresh_history_file(
    history: &mut HistoryCache,
    path: &Path,
    profile: &dyn backend::BackendProfile,
    fingerprint: FileFingerprint,
) -> bool {
    let backend = profile.usage_key();
    let unchanged = history
        .files
        .get(path)
        .is_some_and(|cached| cached.backend == backend && cached.fingerprint == fingerprint);
    if unchanged {
        return false;
    }

    let events = profile.parse_usage_file(path, fingerprint.modified_ms());
    history.files.insert(
        path.to_path_buf(),
        CachedHistoryFile {
            backend: backend.to_string(),
            fingerprint,
            events,
        },
    );
    true
}

fn aggregate_event(
    event: &UsageEvent,
    since_ms: Option<i64>,
    history_since_ms: i64,
    timezone_offset_minutes: Option<i32>,
    usage: &mut UsageMap,
    daily: &mut DailyMap,
) {
    if since_ms.is_none_or(|since| {
        event
            .timestamp_ms
            .is_some_and(|timestamp| timestamp >= since)
    }) {
        add_usage(usage, &event.backend, &event.model, event.usage.clone());
    }
    if event
        .timestamp_ms
        .is_some_and(|timestamp| timestamp >= history_since_ms)
    {
        add_daily(
            daily,
            event.timestamp_ms.unwrap_or_default(),
            event.usage.total,
            timezone_offset_minutes,
        );
    }
}

fn add_usage(usage: &mut UsageMap, backend: &str, model: &str, add: UsageBucket) {
    let bucket = usage
        .entry((backend.to_string(), model.to_string()))
        .or_default();
    bucket.input = bucket.input.saturating_add(add.input);
    bucket.output = bucket.output.saturating_add(add.output);
    bucket.cached = bucket.cached.saturating_add(add.cached);
    bucket.total = bucket.total.saturating_add(add.total);
    bucket.requests = bucket.requests.saturating_add(add.requests);
}

fn add_daily(daily: &mut DailyMap, timestamp_ms: i64, tokens: u64, offset_minutes: Option<i32>) {
    let offset = offset_minutes.and_then(|minutes| chrono::FixedOffset::east_opt(minutes * 60));
    let Some(at) = offset
        .and_then(|zone| {
            zone.timestamp_millis_opt(timestamp_ms)
                .single()
                .map(|time| time.format("%Y-%m-%d").to_string())
        })
        .or_else(|| {
            Local
                .timestamp_millis_opt(timestamp_ms)
                .single()
                .map(|time| time.format("%Y-%m-%d").to_string())
        })
    else {
        return;
    };
    let entry = daily.entry(at).or_default();
    *entry = entry.saturating_add(tokens);
}

fn finish_snapshot(
    period: &str,
    scanned_files: usize,
    usage: UsageMap,
    daily_usage: DailyMap,
    timezone_offset_minutes: Option<i32>,
) -> ModelUsageSnapshot {
    let mut rows = Vec::with_capacity(usage.len());
    let mut totals = ModelUsageTotals::default();
    for ((backend, model), bucket) in usage {
        let cost = kode_core::cost::cost_usd(&model, bucket.input, bucket.output, bucket.cached)
            .unwrap_or(0.0);
        totals.input_tokens = totals.input_tokens.saturating_add(bucket.input);
        totals.output_tokens = totals.output_tokens.saturating_add(bucket.output);
        totals.cached_tokens = totals.cached_tokens.saturating_add(bucket.cached);
        totals.total_tokens = totals.total_tokens.saturating_add(bucket.total);
        totals.cost_usd += cost;
        rows.push(ModelUsageRow {
            source: "local".into(),
            backend,
            model,
            input_tokens: bucket.input,
            output_tokens: bucket.output,
            cached_tokens: bucket.cached,
            total_tokens: bucket.total,
            cost_usd: cost,
            requests: bucket.requests,
        });
    }
    rows.sort_by(|left, right| {
        right
            .total_tokens
            .cmp(&left.total_tokens)
            .then_with(|| left.backend.cmp(&right.backend))
            .then_with(|| left.model.cmp(&right.model))
    });
    totals.cost_usd = (totals.cost_usd * 1_000_000.0).round() / 1_000_000.0;
    for row in &mut rows {
        row.cost_usd = (row.cost_usd * 1_000_000.0).round() / 1_000_000.0;
    }
    let today = display_today(timezone_offset_minutes);
    let daily = (0..DAILY_HISTORY_DAYS)
        .rev()
        .map(|offset| {
            let date = today - ChronoDuration::days(offset);
            let key = date.format("%Y-%m-%d").to_string();
            ModelUsageDay {
                total_tokens: daily_usage.get(&key).copied().unwrap_or(0),
                date: key,
            }
        })
        .collect();
    ModelUsageSnapshot {
        period: period.to_string(),
        scanned_files,
        rows,
        totals,
        daily,
        warnings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_always_contains_twelve_weeks_of_days() {
        let snapshot = finish_snapshot("today", 0, UsageMap::new(), DailyMap::new(), None);
        assert_eq!(snapshot.daily.len(), DAILY_HISTORY_DAYS as usize);
        assert!(snapshot.daily.iter().all(|day| day.total_tokens == 0));
    }

    #[test]
    fn unchanged_history_file_reuses_cached_events() {
        let unique = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kode-model-usage-cache-{}-{unique}.jsonl",
            std::process::id()
        ));
        let first_line = serde_json::json!({
            "timestamp": "2026-07-21T12:00:00Z",
            "providerData": {
                "requestModelId": "claude-opus-4.7",
                "usage": {"totalTokens": 120, "inputTokens": 100, "outputTokens": 20}
            }
        });
        fs::write(&path, format!("{first_line}\n")).unwrap();

        let mut history = HistoryCache::default();
        let first_fingerprint = file_fingerprint(&path).unwrap();
        let profile = backend::profile_for_key("codebuddy").unwrap();
        assert!(refresh_history_file(
            &mut history,
            &path,
            profile,
            first_fingerprint
        ));
        assert_eq!(history.files[&path].events.len(), 1);
        assert!(!refresh_history_file(
            &mut history,
            &path,
            profile,
            first_fingerprint
        ));

        fs::write(&path, format!("{first_line}\n{first_line}\n")).unwrap();
        let second_fingerprint = file_fingerprint(&path).unwrap();
        assert_ne!(first_fingerprint, second_fingerprint);
        assert!(refresh_history_file(
            &mut history,
            &path,
            profile,
            second_fingerprint
        ));
        assert_eq!(history.files[&path].events.len(), 2);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn cached_events_are_filtered_when_building_a_period_snapshot() {
        let mut usage = UsageMap::new();
        let mut daily = DailyMap::new();
        let event = UsageEvent {
            backend: "codex".to_string(),
            model: "gpt-5.6".to_string(),
            timestamp_ms: Some(1_000),
            usage: UsageBucket {
                input: 90,
                output: 10,
                total: 100,
                requests: 1,
                ..UsageBucket::default()
            },
        };

        aggregate_event(&event, Some(2_000), 0, None, &mut usage, &mut daily);
        assert!(usage.is_empty());
        assert_eq!(daily.values().copied().sum::<u64>(), 100);

        aggregate_event(&event, None, 0, None, &mut usage, &mut daily);
        assert_eq!(
            usage[&("codex".to_string(), "gpt-5.6".to_string())].total,
            100
        );
    }

    #[test]
    fn client_timezone_groups_events_at_its_midnight() {
        let mut usage = UsageMap::new();
        let mut daily = DailyMap::new();
        let event = UsageEvent {
            backend: "tclaude".into(),
            model: "test-model".into(),
            timestamp_ms: Some(chrono::DateTime::parse_from_rfc3339("2026-10-20T17:00:00Z")
                .unwrap()
                .timestamp_millis()),
            usage: UsageBucket {
                total: 7,
                ..UsageBucket::default()
            },
        };
        aggregate_event(
            &event,
            Some(event.timestamp_ms.unwrap()),
            0,
            Some(480),
            &mut usage,
            &mut daily,
        );
        assert_eq!(daily.get("2026-10-21"), Some(&7));
        assert_eq!(usage[&("tclaude".into(), "test-model".into())].total, 7);
        assert!(normalize_period("yesterday").is_err());
    }
}
