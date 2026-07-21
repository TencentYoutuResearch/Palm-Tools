//! 模型 → 单价(USD per 1M token)估算表 + cost 计算函数。
//!
//! 数据时点:2026-05,主流厂商对外定价。
//! 注意:codebuddy 的 jsonl 只给 `totalTokens` 一个数字(input + output 之和),
//! 我们没法精确算 split,所以这里**用 (input+output)/2 的混合单价**估个大致量级;
//! 真要精算请去看 jsonl 里的 inputTokens / outputTokens(若有)。

/// 返回 (input_per_million_usd, output_per_million_usd)
pub fn price_per_million(model: &str) -> Option<(f64, f64)> {
    // 归一化:去前缀、转小写
    let m = model
        .trim()
        .trim_start_matches("anthropic.")
        .trim_start_matches("claude-")
        .to_ascii_lowercase();

    // claude 系列(Anthropic 官方价 + codebuddy ID 双兼容)
    if m.contains("opus") {
        // Opus 系列基本价(2025-2026 通行)
        return Some((15.0, 75.0));
    }
    if m.contains("sonnet") {
        // Sonnet 系列
        return Some((3.0, 15.0));
    }
    if m.contains("haiku") {
        return Some((0.8, 4.0));
    }

    // gpt 系列(OpenAI / codebuddy ioa 后缀都对应 gpt-5.x)
    if m.starts_with("gpt-5") || m.starts_with("gpt-4.5") {
        return Some((5.0, 15.0));
    }
    if m.starts_with("gpt-4o") {
        return Some((2.5, 10.0));
    }
    if m.starts_with("gpt-4") {
        return Some((10.0, 30.0));
    }
    if m.starts_with("gpt-3.5") {
        return Some((0.5, 1.5));
    }

    // gemini 系列
    if m.starts_with("gemini") {
        if m.contains("flash") {
            return Some((0.075, 0.3));
        }
        // pro
        return Some((1.25, 5.0));
    }

    // glm / kimi / minimax / deepseek / hy:用一个保守的中位估算
    if m.starts_with("glm")
        || m.starts_with("kimi")
        || m.starts_with("minimax")
        || m.starts_with("deepseek")
        || m.starts_with("hy")
    {
        return Some((0.5, 2.0));
    }

    None
}

/// 用 total_tokens(input + output 之和)+ model 估算累计 cost(USD)。
/// 假定 input:output = 2:1 的典型对话比例(更接近实际 codebuddy / claude code 用量)。
///
/// 这是**只有 totalTokens 时**的回退路径;如果有精确 input / output / cached
/// 拆分,优先用 [`cost_usd`]。
pub fn estimate_cost_usd(model: &str, total_tokens: u64) -> Option<f64> {
    let (in_pm, out_pm) = price_per_million(model)?;
    if total_tokens == 0 {
        return Some(0.0);
    }
    let total = total_tokens as f64;
    // 2:1 split
    let input = total * (2.0 / 3.0);
    let output = total * (1.0 / 3.0);
    Some((input * in_pm + output * out_pm) / 1_000_000.0)
}

/// 精确版 cost 计算:input / output / cached 都已知。
///
/// 公式:
///   cost = (input - cached) * in_pm
///        + cached * in_pm * 0.1     （cache hit 折扣按 90% off,Anthropic 与 OpenAI 通行)
///        + output * out_pm
///   单位:per million token
///
/// `cached` 是 input 的子集(已包含在 input 里,不是独立计数)。
pub fn cost_usd(
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
) -> Option<f64> {
    let (in_pm, out_pm) = price_per_million(model)?;
    let cached = cached_tokens.min(input_tokens) as f64;
    let fresh_input = (input_tokens as f64) - cached;
    let output = output_tokens as f64;
    let cost = (fresh_input * in_pm + cached * in_pm * 0.1 + output * out_pm) / 1_000_000.0;
    Some(cost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_pricing() {
        let (i, o) = price_per_million("claude-opus-4.7").unwrap();
        assert_eq!(i, 15.0);
        assert_eq!(o, 75.0);
    }

    #[test]
    fn sonnet_pricing_via_long_id() {
        let (i, _o) = price_per_million("claude-sonnet-4-5-20250929").unwrap();
        assert_eq!(i, 3.0);
    }

    #[test]
    fn gpt_5_pricing() {
        let (i, o) = price_per_million("gpt-5.3-codex").unwrap();
        assert_eq!(i, 5.0);
        assert_eq!(o, 15.0);
    }

    #[test]
    fn gemini_flash_cheap() {
        let (i, _o) = price_per_million("gemini-3.5-flash").unwrap();
        assert_eq!(i, 0.075);
    }

    #[test]
    fn unknown_model_none() {
        assert_eq!(price_per_million("foo-bar"), None);
    }

    #[test]
    fn cost_zero_for_zero_tokens() {
        assert_eq!(estimate_cost_usd("claude-opus-4.7", 0), Some(0.0));
    }

    #[test]
    fn cost_for_known_volume() {
        // 1M tokens of opus, 2:1 split -> 2/3 * 15 + 1/3 * 75 = 10 + 25 = $35
        let c = estimate_cost_usd("claude-opus-4.7", 1_000_000).unwrap();
        assert!((c - 35.0).abs() < 0.01, "got {c}");
    }

    #[test]
    fn cost_usd_no_cache() {
        // 100k input, 50k output, 0 cached, opus = (100k * 15 + 50k * 75) / 1M = 1.5 + 3.75 = 5.25
        let c = cost_usd("claude-opus-4.7", 100_000, 50_000, 0).unwrap();
        assert!((c - 5.25).abs() < 0.01, "got {c}");
    }

    #[test]
    fn cost_usd_with_cache_discount() {
        // 100k input (其中 80k cached), 0 output, opus
        // = (20k * 15 + 80k * 15 * 0.1) / 1M
        // = 0.3 + 0.12 = 0.42
        let c = cost_usd("claude-opus-4.7", 100_000, 0, 80_000).unwrap();
        assert!((c - 0.42).abs() < 0.01, "got {c}");
    }

    #[test]
    fn cost_usd_clamps_cached_to_input() {
        // cached > input → 当作 = input(不会出现负 fresh)
        let c = cost_usd("claude-opus-4.7", 100, 0, 1_000_000).unwrap();
        assert!(c >= 0.0);
    }

    #[test]
    fn cost_usd_unknown_model_none() {
        assert_eq!(cost_usd("foo-bar", 1000, 1000, 0), None);
    }
}
