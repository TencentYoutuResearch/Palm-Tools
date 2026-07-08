//! 模型 → context window 大小映射,用于计算"context 用了多少 %"。
//!
//! 数据时点:2026-05。**只覆盖主流模型**,未知返回 None,UI 应显示 `—`。
//!
//! 注意:codebuddy 的 jsonl 里 `inputTokens` 是"本次请求的 input token 数",
//! 累加 input + output 才是当前 conversation 占的 context。所以传给 `context_pct`
//! 的应该是"已知 input + output 的最大值"或"最近一次请求的 input 累计值"。

/// 根据模型名返回 context window 大小(token)。
/// 已对齐 `model_alias::short_model_name` 的输入空间。
pub fn context_window(model: &str) -> Option<u64> {
    let m = model.trim().to_ascii_lowercase();
    if m.is_empty() || m == "auto" {
        return None;
    }

    // ── 显式 1m / 1M context 标记(claude 4.x 1m 后缀,gpt-4.5-1m 等)
    if m.contains("1m") {
        return Some(1_000_000);
    }
    // 显式 200k(罕见但正式名里偶有)
    if m.contains("200k") {
        return Some(200_000);
    }
    if m.contains("128k") {
        return Some(128_000);
    }

    // ── claude 系列默认 200k(opus / sonnet / haiku 4.x)
    let after = m
        .trim_start_matches("anthropic.")
        .trim_start_matches("claude-");
    if after.starts_with("opus") || after.starts_with("sonnet") || after.starts_with("haiku") {
        return Some(200_000);
    }

    // ── gpt 系列
    if after.starts_with("gpt-5") || m.starts_with("gpt-5") {
        return Some(400_000); // gpt-5.x 默认 400k
    }
    if after.starts_with("gpt-4o") || m.starts_with("gpt-4o") {
        return Some(128_000);
    }
    if after.starts_with("gpt-4") || m.starts_with("gpt-4") {
        return Some(128_000);
    }
    if after.starts_with("gpt-3.5") || m.starts_with("gpt-3.5") {
        return Some(16_000);
    }

    // ── gemini 系列默认 1m(pro)/ 1m(flash 在 2.x+ 也是 1m)
    if m.starts_with("gemini") {
        return Some(1_000_000);
    }

    // ── 国产系列保守给 128k
    if m.starts_with("glm")
        || m.starts_with("kimi")
        || m.starts_with("minimax")
        || m.starts_with("deepseek")
        || m.starts_with("hy")
    {
        return Some(128_000);
    }

    None
}

/// context 占用百分比(0.0-100.0)。
/// `used_tokens` 是当前 conversation 累计 input+output(或最近一次 request 的 input)。
pub fn context_pct(model: &str, used_tokens: u64) -> Option<f32> {
    let win = context_window(model)?;
    if win == 0 {
        return None;
    }
    let pct = (used_tokens as f64 / win as f64) * 100.0;
    Some(pct.min(999.9) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_default_200k() {
        assert_eq!(context_window("claude-opus-4.7"), Some(200_000));
        assert_eq!(context_window("opus-4.7"), Some(200_000));
    }

    #[test]
    fn opus_1m_suffix() {
        assert_eq!(context_window("claude-opus-4.7-1m"), Some(1_000_000));
        assert_eq!(context_window("opus-4.7-1m"), Some(1_000_000));
    }

    #[test]
    fn sonnet_friendly_with_1m() {
        // 注意大小写敏感,小写化在函数内完成
        assert_eq!(context_window("Claude-Sonnet-4.6-1M"), Some(1_000_000));
    }

    #[test]
    fn gpt5_default_400k() {
        assert_eq!(context_window("gpt-5.3-codex"), Some(400_000));
    }

    #[test]
    fn gemini_1m() {
        assert_eq!(context_window("gemini-3.1-pro"), Some(1_000_000));
    }

    #[test]
    fn unknown_returns_none() {
        assert_eq!(context_window("foo-bar"), None);
        assert_eq!(context_window(""), None);
        assert_eq!(context_window("auto"), None);
    }

    #[test]
    fn pct_basic() {
        let p = context_pct("claude-opus-4.7", 100_000).unwrap();
        assert!((p - 50.0).abs() < 0.01, "got {p}");
    }

    #[test]
    fn pct_unknown_model_none() {
        assert_eq!(context_pct("foo", 1000), None);
    }
}
