//! Desktop usage from local histories and registered remote bridges.

use std::collections::{HashMap, HashSet};

use kode_bridge::model_usage::{self, ModelUsageRow, ModelUsageSnapshot, ModelUsageTotals};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn model_usage_snapshot(
    period: String,
    state: State<'_, AppState>,
) -> Result<ModelUsageSnapshot, String> {
    let period = model_usage::normalize_period(&period)?.to_string();
    let since = model_usage::period_start_ms(&period);
    let offset = chrono::Local::now().offset().local_minus_utc() / 60;
    let local_period = period.clone();
    let mut combined = tauri::async_runtime::spawn_blocking(move || {
        model_usage::collect_snapshot(&local_period, since, Some(offset))
    })
    .await
    .map_err(|error| format!("model usage task failed: {error}"))??;
    let mut remotes: Vec<_> = state
        .remote_transports
        .lock()
        .iter()
        .map(|(id, transport)| (id.clone(), transport.clone()))
        .collect();
    remotes.sort_by(|a, b| a.0.cmp(&b.0));
    let mut seen_servers = HashSet::new();
    for (id, transport) in remotes {
        let host_key = transport.usage_host_key();
        if seen_servers.contains(&host_key) {
            continue;
        }
        let offset_string = offset.to_string();
        let since_string = since.map(|value| value.to_string());
        let mut query = vec![
            ("period", period.as_str()),
            ("timezone_offset_minutes", offset_string.as_str()),
        ];
        if let Some(value) = since_string.as_deref() {
            query.push(("since_ms", value));
        }
        match tokio::time::timeout(
            std::time::Duration::from_secs(12),
            transport.rest_get("/api/v1/model-usage", &query),
        )
        .await
        {
            Err(_) => combined
                .warnings
                .push(format!("{id}: usage request timed out")),
            Ok(Ok(payload)) => match serde_json::from_value::<ModelUsageSnapshot>(payload) {
                Ok(snapshot) if snapshot.period == period => {
                    seen_servers.insert(host_key);
                    merge_remote(&mut combined, snapshot, &id);
                }
                Ok(_) => combined
                    .warnings
                    .push(format!("{id}: invalid usage period")),
                Err(error) => combined
                    .warnings
                    .push(format!("{id}: invalid usage response: {error}")),
            },
            Ok(Err(error)) if error.status == Some(404) => combined
                .warnings
                .push(format!("{id}: update the remote bridge to view usage")),
            Ok(Err(error)) => combined.warnings.push(format!("{id}: {error}")),
        }
    }
    Ok(combined)
}

fn merge_remote(combined: &mut ModelUsageSnapshot, remote: ModelUsageSnapshot, source: &str) {
    combined.scanned_files += remote.scanned_files;
    combined.warnings.extend(
        remote
            .warnings
            .into_iter()
            .map(|warning| format!("{source}: {warning}")),
    );
    let days: HashMap<String, u64> = remote
        .daily
        .into_iter()
        .map(|day| (day.date, day.total_tokens))
        .collect();
    for day in &mut combined.daily {
        day.total_tokens = day
            .total_tokens
            .saturating_add(days.get(&day.date).copied().unwrap_or(0));
    }
    for mut row in remote.rows {
        row.source = source.into();
        combined.rows.push(row);
    }
    recalculate(&mut combined.rows, &mut combined.totals);
}

fn recalculate(rows: &mut [ModelUsageRow], totals: &mut ModelUsageTotals) {
    *totals = ModelUsageTotals::default();
    for row in rows.iter() {
        totals.input_tokens = totals.input_tokens.saturating_add(row.input_tokens);
        totals.output_tokens = totals.output_tokens.saturating_add(row.output_tokens);
        totals.cached_tokens = totals.cached_tokens.saturating_add(row.cached_tokens);
        totals.total_tokens = totals.total_tokens.saturating_add(row.total_tokens);
        totals.cost_usd += row.cost_usd;
    }
    rows.sort_by(|a, b| {
        b.total_tokens
            .cmp(&a.total_tokens)
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.backend.cmp(&b.backend))
            .then_with(|| a.model.cmp(&b.model))
    });
    totals.cost_usd = (totals.cost_usd * 1_000_000.0).round() / 1_000_000.0;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merging_remote_preserves_source_and_daily_counts() {
        let mut local = ModelUsageSnapshot {
            period: "today".into(),
            scanned_files: 1,
            rows: Vec::new(),
            totals: Default::default(),
            daily: vec![kode_bridge::model_usage::ModelUsageDay {
                date: "2026-10-21".into(),
                total_tokens: 4,
            }],
            warnings: Vec::new(),
        };
        let mut remote = local.clone();
        remote.scanned_files = 2;
        remote.rows.push(ModelUsageRow {
            source: String::new(),
            backend: "tcodex".into(),
            model: "test".into(),
            input_tokens: 3,
            output_tokens: 2,
            cached_tokens: 0,
            total_tokens: 5,
            cost_usd: 0.,
            requests: 1,
        });
        remote.daily[0].total_tokens = 5;
        merge_remote(&mut local, remote, "server");
        assert_eq!(local.totals.total_tokens, 5);
        assert_eq!(local.rows[0].source, "server");
        assert_eq!(local.daily[0].total_tokens, 9);
        assert_eq!(local.scanned_files, 3);
    }
}
