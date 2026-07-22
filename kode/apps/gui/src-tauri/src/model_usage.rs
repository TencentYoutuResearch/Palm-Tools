//! 按 CLI + model 聚合本地 token 历史。
//!
//! 数据直接读各 CLI 的 JSONL/rollout，不依赖当前 kode tab：
//! - CodeBuddy: `~/.codebuddy/projects/**/*.jsonl`
//! - Claude: `~/.claude/projects/**/*.jsonl`
//! - Codex: `~/.codex/sessions/**/rollout-*.jsonl`
//!
//! CodeBuddy / Claude 的 usage 是每次请求值，直接累加；Codex 的
//! `total_token_usage` 是 session 累计值，必须先做相邻事件增量再归属到当前 model。

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone};
use serde::Serialize;
use serde_json::Value;

const MAX_JSONL_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_HISTORY_FILES: usize = 50_000;
const DAILY_HISTORY_DAYS: i64 = 84;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ModelUsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelUsageRow {
    pub backend: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub requests: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelUsageSnapshot {
    pub period: String,
    pub scanned_files: usize,
    pub rows: Vec<ModelUsageRow>,
    pub totals: ModelUsageTotals,
    pub daily: Vec<ModelUsageDay>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelUsageDay {
    pub date: String,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Default)]
struct UsageBucket {
    input: u64,
    output: u64,
    cached: u64,
    total: u64,
    requests: u64,
}

#[derive(Debug, Clone)]
struct UsageEvent {
    backend: String,
    model: String,
    timestamp_ms: Option<i64>,
    usage: UsageBucket,
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

#[tauri::command]
pub async fn model_usage_snapshot(period: String) -> Result<ModelUsageSnapshot, String> {
    let period = normalize_period(&period)?;
    let period_owned = period.to_string();
    tauri::async_runtime::spawn_blocking(move || collect_snapshot(&period_owned))
        .await
        .map_err(|error| format!("model usage task failed: {error}"))?
}

fn normalize_period(period: &str) -> Result<&'static str, String> {
    match period {
        "today" => Ok("today"),
        "month" => Ok("month"),
        "all" => Ok("all"),
        _ => Err(format!("unsupported model usage period: {period}")),
    }
}

fn period_start_ms(period: &str) -> Option<i64> {
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

fn daily_history_start_ms() -> i64 {
    let date = Local::now().date_naive() - ChronoDuration::days(DAILY_HISTORY_DAYS - 1);
    let start = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    Local
        .from_local_datetime(&start)
        .earliest()
        .expect("local midnight exists")
        .timestamp_millis()
}

fn collect_snapshot(period: &str) -> Result<ModelUsageSnapshot, String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    let since_ms = period_start_ms(period);
    let history_since_ms = daily_history_start_ms();
    let file_since_ms = since_ms.map(|since| since.min(history_since_ms));
    let mut usage = UsageMap::new();
    let mut daily = DailyMap::new();
    let mut scanned_files = 0usize;
    let mut considered_files = 0usize;
    let mut seen_paths = HashSet::new();
    let mut history = history_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let sources = [
        ("codebuddy", home.join(".codebuddy/projects")),
        ("claude", home.join(".claude/projects")),
        ("codex", home.join(".codex/sessions")),
    ];

    for (backend, root) in sources {
        let mut files = Vec::new();
        collect_jsonl_files(&root, 0, &mut files);
        for path in files {
            if considered_files >= MAX_HISTORY_FILES {
                break;
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

            refresh_history_file(&mut history, &path, backend, fingerprint);
            if let Some(cached) = history.files.get(&path) {
                for event in &cached.events {
                    aggregate_event(event, since_ms, history_since_ms, &mut usage, &mut daily);
                }
            }
        }
        if considered_files >= MAX_HISTORY_FILES {
            break;
        }
    }

    history.files.retain(|path, _| seen_paths.contains(path));

    Ok(finish_snapshot(period, scanned_files, usage, daily))
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

#[derive(Clone, Copy)]
enum RequestFormat {
    CodeBuddy,
    Claude,
}

fn refresh_history_file(
    history: &mut HistoryCache,
    path: &Path,
    backend: &str,
    fingerprint: FileFingerprint,
) -> bool {
    let unchanged = history
        .files
        .get(path)
        .is_some_and(|cached| cached.backend == backend && cached.fingerprint == fingerprint);
    if unchanged {
        return false;
    }

    let events = parse_history_file(path, backend, fingerprint.modified_ms());
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

fn parse_history_file(path: &Path, backend: &str, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
    match backend {
        "codebuddy" => request_file_events(path, backend, fallback_ms, RequestFormat::CodeBuddy),
        "claude" => request_file_events(path, backend, fallback_ms, RequestFormat::Claude),
        "codex" => codex_file_events(path, fallback_ms),
        _ => Vec::new(),
    }
}

fn request_file_events(
    path: &Path,
    backend: &str,
    fallback_ms: Option<i64>,
    format: RequestFormat,
) -> Vec<UsageEvent> {
    let mut events = Vec::new();
    for_each_json_line(path, |value| {
        let request = match format {
            RequestFormat::CodeBuddy => parse_codebuddy_request(value),
            RequestFormat::Claude => parse_claude_request(value),
        };
        if let Some((model, bucket)) = request {
            events.push(UsageEvent {
                backend: backend.to_string(),
                model,
                timestamp_ms: event_timestamp_ms(value).or(fallback_ms),
                usage: bucket,
            });
        }
    });
    events
}

fn parse_codebuddy_request(value: &Value) -> Option<(String, UsageBucket)> {
    let provider = value.get("providerData")?;
    let raw_model = provider
        .get("requestModelId")
        .or_else(|| provider.get("model"))?
        .as_str()?;
    let model = clean_model(raw_model);
    if model.is_empty() {
        return None;
    }
    let usage = provider.get("usage")?;
    let input = number(usage, "inputTokens");
    let output = number(usage, "outputTokens");
    let total = number(usage, "totalTokens").max(input.saturating_add(output));
    if total == 0 {
        return None;
    }
    let cached = usage
        .get("inputTokensDetails")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .map(|item| number(item, "cached_tokens"))
        .unwrap_or(0);
    Some((
        model,
        UsageBucket {
            input,
            output,
            cached,
            total,
            requests: 1,
        },
    ))
}

fn parse_claude_request(value: &Value) -> Option<(String, UsageBucket)> {
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = value.get("message")?;
    let model = clean_model(message.get("model")?.as_str()?);
    if model.is_empty() {
        return None;
    }
    let usage = message.get("usage")?;
    let fresh_input = number(usage, "input_tokens");
    let cache_write = number(usage, "cache_creation_input_tokens");
    let cached = number(usage, "cache_read_input_tokens");
    let input = fresh_input
        .saturating_add(cache_write)
        .saturating_add(cached);
    let output = number(usage, "output_tokens");
    let total = input.saturating_add(output);
    if total == 0 {
        return None;
    }
    Some((
        model,
        UsageBucket {
            input,
            output,
            cached,
            total,
            requests: 1,
        },
    ))
}

fn codex_file_events(path: &Path, fallback_ms: Option<i64>) -> Vec<UsageEvent> {
    let mut events = Vec::new();
    let mut model = String::from("unknown");
    let mut previous = UsageBucket::default();

    for_each_json_line(path, |value| {
        let entry_type = value.get("type").and_then(Value::as_str);
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if entry_type == Some("turn_context") {
            if let Some(raw) = payload.get("model").and_then(Value::as_str) {
                let next = clean_model(raw);
                if !next.is_empty() {
                    model = next;
                }
            }
            return;
        }
        if entry_type != Some("event_msg")
            || payload.get("type").and_then(Value::as_str) != Some("token_count")
        {
            return;
        }
        let Some(info) = payload.get("info") else {
            return;
        };
        let (current, cumulative) = if let Some(total) = info.get("total_token_usage") {
            (codex_usage(total), true)
        } else if let Some(last) = info.get("last_token_usage") {
            (codex_usage(last), false)
        } else {
            return;
        };
        let delta = if cumulative {
            let delta = usage_delta(&current, &previous);
            previous = current;
            delta
        } else {
            current
        };
        if delta.total > 0 {
            events.push(UsageEvent {
                backend: "codex".to_string(),
                model: model.clone(),
                timestamp_ms: event_timestamp_ms(value).or(fallback_ms),
                usage: UsageBucket {
                    requests: 1,
                    ..delta
                },
            });
        }
    });
    events
}

fn codex_usage(value: &Value) -> UsageBucket {
    let input = number(value, "input_tokens");
    let output = number(value, "output_tokens");
    let cached = number(value, "cached_input_tokens");
    let total = number(value, "total_tokens").max(input.saturating_add(output));
    UsageBucket {
        input,
        output,
        cached,
        total,
        requests: 0,
    }
}

fn usage_delta(current: &UsageBucket, previous: &UsageBucket) -> UsageBucket {
    fn delta(current: u64, previous: u64) -> u64 {
        if current >= previous {
            current - previous
        } else {
            current
        }
    }
    UsageBucket {
        input: delta(current.input, previous.input),
        output: delta(current.output, previous.output),
        cached: delta(current.cached, previous.cached),
        total: delta(current.total, previous.total),
        requests: 0,
    }
}

fn for_each_json_line(path: &Path, mut visit: impl FnMut(&Value)) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(read) = reader.read_line(&mut line) else {
            break;
        };
        if read == 0 {
            break;
        }
        if read > MAX_JSONL_LINE_BYTES {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            visit(&value);
        }
    }
}

fn event_timestamp_ms(value: &Value) -> Option<i64> {
    let raw = value
        .get("timestamp")
        .or_else(|| value.get("created_at"))
        .or_else(|| value.get("createdAt"))?;
    if let Some(number) = raw.as_i64() {
        return Some(if number.abs() < 100_000_000_000 {
            number * 1_000
        } else {
            number
        });
    }
    let text = raw.as_str()?.trim();
    if let Ok(number) = text.parse::<i64>() {
        return Some(if number.abs() < 100_000_000_000 {
            number * 1_000
        } else {
            number
        });
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn clean_model(model: &str) -> String {
    kode_core::model_alias::sanitize_model_name(model)
        .trim()
        .to_string()
}

fn number(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|raw| raw.as_u64().or_else(|| raw.as_str()?.parse().ok()))
        .unwrap_or(0)
}

fn aggregate_event(
    event: &UsageEvent,
    since_ms: Option<i64>,
    history_since_ms: i64,
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

fn add_daily(daily: &mut DailyMap, timestamp_ms: i64, tokens: u64) {
    let Some(at) = Local.timestamp_millis_opt(timestamp_ms).single() else {
        return;
    };
    let date = at.format("%Y-%m-%d").to_string();
    let entry = daily.entry(date).or_default();
    *entry = entry.saturating_add(tokens);
}

fn finish_snapshot(
    period: &str,
    scanned_files: usize,
    usage: UsageMap,
    daily_usage: DailyMap,
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
    let today = Local::now().date_naive();
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codebuddy_request_is_grouped_by_model() {
        let value = serde_json::json!({
            "type": "message",
            "providerData": {
                "requestModelId": "claude-opus-4.7",
                "usage": {
                    "totalTokens": 120,
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "inputTokensDetails": [{"cached_tokens": 40}]
                }
            }
        });
        let (model, usage) = parse_codebuddy_request(&value).unwrap();
        assert_eq!(model, "claude-opus-4.7");
        assert_eq!(
            (usage.input, usage.output, usage.cached, usage.total),
            (100, 20, 40, 120)
        );
    }

    #[test]
    fn claude_cache_write_and_read_are_input() {
        let value = serde_json::json!({
            "type": "assistant",
            "message": {"model": "claude-sonnet-4", "usage": {
                "input_tokens": 10,
                "cache_creation_input_tokens": 30,
                "cache_read_input_tokens": 50,
                "output_tokens": 20
            }}
        });
        let (_, usage) = parse_claude_request(&value).unwrap();
        assert_eq!(
            (usage.input, usage.output, usage.cached, usage.total),
            (90, 20, 50, 110)
        );
    }

    #[test]
    fn codex_cumulative_usage_uses_delta() {
        let previous = UsageBucket {
            input: 100,
            output: 20,
            cached: 40,
            total: 120,
            requests: 0,
        };
        let current = UsageBucket {
            input: 160,
            output: 35,
            cached: 70,
            total: 195,
            requests: 0,
        };
        let delta = usage_delta(&current, &previous);
        assert_eq!(
            (delta.input, delta.output, delta.cached, delta.total),
            (60, 15, 30, 75)
        );
    }

    #[test]
    fn parses_rfc3339_event_timestamp() {
        let value = serde_json::json!({"timestamp": "2026-01-01T00:00:00Z"});
        assert_eq!(event_timestamp_ms(&value), Some(1_767_225_600_000));
    }

    #[test]
    fn snapshot_always_contains_twelve_weeks_of_days() {
        let snapshot = finish_snapshot("today", 0, UsageMap::new(), DailyMap::new());
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
        assert!(refresh_history_file(
            &mut history,
            &path,
            "codebuddy",
            first_fingerprint
        ));
        assert_eq!(history.files[&path].events.len(), 1);
        assert!(!refresh_history_file(
            &mut history,
            &path,
            "codebuddy",
            first_fingerprint
        ));

        fs::write(&path, format!("{first_line}\n{first_line}\n")).unwrap();
        let second_fingerprint = file_fingerprint(&path).unwrap();
        assert_ne!(first_fingerprint, second_fingerprint);
        assert!(refresh_history_file(
            &mut history,
            &path,
            "codebuddy",
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

        aggregate_event(&event, Some(2_000), 0, &mut usage, &mut daily);
        assert!(usage.is_empty());
        assert_eq!(daily.values().copied().sum::<u64>(), 100);

        aggregate_event(&event, None, 0, &mut usage, &mut daily);
        assert_eq!(
            usage[&("codex".to_string(), "gpt-5.6".to_string())].total,
            100
        );
    }
}
