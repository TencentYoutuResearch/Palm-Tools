//! 模型简称归一 —— UI 层(TUI / GUI / 未来手机端)展示模型时的统一短名。
//!
//! 输入:codebuddy / claude / openai / gemini 等任意来源的模型字符串。
//! 输出:适合展示在窄列里的短名(目标 ≤ 14 字符)。
//!
//! 典型映射:
//! ```text
//!   claude-opus-4.7              → opus-4.7
//!   claude-opus-4.7-1m           → opus-4.7-1m
//!   claude-sonnet-4-5-20250929   → sonnet-4.5
//!   "Claude-Sonnet-4.6 (1M context)" → sonnet-4.6-1m
//!   anthropic.claude-haiku-4.5   → haiku-4.5
//!   gpt-5.3-codex                → gpt-5.3-codex
//!   gemini-3.1-pro               → gemini-3.1-pro
//!   ""  / "auto"                 → 原样
//! ```
//!
//! GUI 前端有一份 TS 镜像(`apps/gui/src/lib/model_alias.ts`),双方共享测试夹具
//! `tests/model_alias_fixtures.json`,确保两实现一致。

/// 主入口:把任意来源的模型字符串压成短展示名。
pub fn short_model_name(raw: &str) -> String {
    let cleaned = sanitize_model_name(raw);
    let s = cleaned.trim();
    if s.is_empty() || s == "auto" {
        return s.to_string();
    }

    // 1) 处理"友好名"格式:"Claude-Sonnet-4.6 (1M context)" / "Claude Opus 4.7 (1M)"
    //    思路:抓括号外的主体 + 抓括号内的"1M / 200K"标签作 suffix
    let (body, paren_suffix) = split_paren(s);

    // 2) 主体内部:转小写 + 把空格换成 dash
    let body = body.trim().replace(' ', "-").to_ascii_lowercase();

    // 3) 去公共前缀(anthropic. / claude- / claude-)
    let body = body
        .trim_start_matches("anthropic.")
        .trim_start_matches("claude-");

    // 4) 把以 dash 分隔的版本号 token 合并回 "4.7" 形式
    //    并丢掉 yyyymmdd
    let parts: Vec<&str> = body.split('-').filter(|p| !p.is_empty()).collect();
    // 4.5) claude code 用 "claude-<ver>-<tier>" 顺序(如 "claude-4.7-opus");
    //      codebuddy / Anthropic 公开 ID 用 "claude-<tier>-<ver>" 顺序。
    //      统一成后者再走 compact_parts。
    let parts = swap_ver_tier_if_needed(parts);
    let compact = compact_parts(&parts);

    // 5) 拼上括号内的简化标签(如 "1m"),若主体里没已经带这个标签
    if let Some(tag) = paren_suffix {
        if !compact.contains(&tag) {
            return format!("{compact}-{tag}");
        }
    }
    compact
}

/// 清理 codebuddy 偶发写进模型字段的 note / 提示后缀,保留真正的模型名。
///
/// 已见过的脏值形态:
/// - `Claude-Opus-4.8-1M Note: The model was saved ...`
/// - `opus-4.8-1m-note:-the-model-was-saved-to-user-settings,...`
/// - `glm-5.2-ioa\nNote: The model was saved to user settings, ...`(note 用换行分隔)
pub fn sanitize_model_name(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }

    let lower = s.to_ascii_lowercase();
    let mut cut = s.len();
    for marker in [
        " note:",
        "-note:",
        "\nnote:",
        "\r\nnote:",
        "\tnote:",
        " the model was saved to user settings",
        "-the-model-was-saved-to-user-settings",
    ] {
        if let Some(idx) = lower.find(marker) {
            cut = cut.min(idx);
        }
    }

    // 兜底:合法 model 名只含 [a-z0-9._-](大小写都行),不会含 \n / \r / \t。
    // 友好名最多用空格(如 "Claude Opus 4.7"),所以这三个字符出现就一定是
    // codebuddy 又夹带了新的 note 形态 —— 直接在第一个 \n/\r/\t 处截断。
    // 这条 fallback 保证未来 codebuddy 换分隔符时不会再漏(只需 marker 列表覆盖空格 case)。
    if let Some(idx) = lower.find(|c: char| matches!(c, '\n' | '\r' | '\t')) {
        cut = cut.min(idx);
    }

    s[..cut]
        .trim_end_matches(|c: char| matches!(c, ' ' | '-'))
        .trim()
        .to_string()
}

/// 把 "Foo (Bar baz)" 拆成 ("Foo", Some("bar"))。
/// 括号内文本会取第一个能识别的 size token(1m / 200k / 128k …),
/// 找不到就返回 None(把括号整段丢了,因为对展示无意义)。
fn split_paren(s: &str) -> (String, Option<String>) {
    if let (Some(lp), Some(rp)) = (s.find('('), s.rfind(')')) {
        if rp > lp {
            let body = format!("{}{}", &s[..lp], &s[rp + 1..]);
            let inside = &s[lp + 1..rp];
            let tag = extract_size_tag(inside);
            return (body.trim().to_string(), tag);
        }
    }
    (s.to_string(), None)
}

/// 从 "1M context" / "200k tokens" 之类的字符串里抠出标准化 size 标签。
/// 返回小写无单位前后缀,如 "1m" / "200k" / "128k"。
fn extract_size_tag(inside: &str) -> Option<String> {
    let lower = inside.to_ascii_lowercase();
    // 找连续 [0-9]+[mk] 的子串
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'k' || bytes[i] == b'm') {
                let unit = bytes[i];
                i += 1;
                return Some(format!("{}{}", &lower[start..i - 1], unit as char));
            }
        } else {
            i += 1;
        }
    }
    None
}

/// 给定 token 列表(已小写,已 trim),把数字段合并、丢日期,输出展示串。
fn compact_parts(parts: &[&str]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    if parts.len() == 1 {
        return parts[0].to_string();
    }

    // 找 name 段尾巴(最后一个不是纯数字的 token 之前的部分)
    let mut split_at = 0usize;
    for (i, p) in parts.iter().enumerate() {
        if !is_versionish(p) {
            split_at = i + 1;
        } else {
            break;
        }
    }
    if split_at == 0 || split_at >= parts.len() {
        // 没有数字尾巴 → 原样 join,但仍丢掉日期
        return parts
            .iter()
            .filter(|p| !is_yyyymmdd(p))
            .copied()
            .collect::<Vec<_>>()
            .join("-");
    }
    let head = parts[..split_at].join("-");
    let mut ver_tokens = vec![];
    let mut suffix_tokens = vec![];
    let mut in_ver = true;
    for p in &parts[split_at..] {
        if in_ver && is_versionish(p) {
            ver_tokens.push(*p);
        } else {
            in_ver = false;
            suffix_tokens.push(*p);
        }
    }
    let mut out = head;
    if !ver_tokens.is_empty() {
        out.push('-');
        out.push_str(&ver_tokens.join("."));
    }
    for t in suffix_tokens {
        if !is_yyyymmdd(t) {
            out.push('-');
            out.push_str(t);
        }
    }
    out
}

fn is_versionish(s: &str) -> bool {
    if s.is_empty() || is_yyyymmdd(s) {
        return false;
    }
    s.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn is_yyyymmdd(s: &str) -> bool {
    s.len() == 8 && s.chars().all(|c| c.is_ascii_digit())
}

/// 处理 claude code 的"ver 在前、tier 在后"格式。
///
/// 输入(已 trim 掉 claude- 前缀):
///   ["4.7", "opus"]            → ["opus", "4.7"]
///   ["4.7", "opus", "1m"]      → ["opus", "4.7", "1m"]
///   ["opus", "4.7"]            → ["opus", "4.7"]   (codebuddy 风,不动)
///   ["foo", "bar"]             → ["foo", "bar"]   (没有 versionish 头,不动)
fn swap_ver_tier_if_needed<'a>(parts: Vec<&'a str>) -> Vec<&'a str> {
    if parts.len() < 2 {
        return parts;
    }
    let first_is_ver = is_versionish(parts[0]);
    if !first_is_ver {
        return parts;
    }
    // 找下一个非 versionish 段(name token)的位置
    let name_idx = parts.iter().skip(1).position(|p| !is_versionish(p));
    let Some(name_idx) = name_idx else {
        return parts;
    };
    let name_idx = name_idx + 1; // 因为 skip(1)
                                 // 拆三段:vers_head | name | rest
    let mut out = Vec::with_capacity(parts.len());
    out.push(parts[name_idx]);
    out.extend_from_slice(&parts[..name_idx]);
    out.extend_from_slice(&parts[name_idx + 1..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_empty_and_auto() {
        assert_eq!(short_model_name(""), "");
        assert_eq!(short_model_name("auto"), "auto");
        assert_eq!(short_model_name("  "), "");
    }

    // 现有 TUI 测试覆盖的 case
    #[test]
    fn claude_opus_dotted() {
        assert_eq!(short_model_name("claude-opus-4.7"), "opus-4.7");
    }

    #[test]
    fn claude_opus_with_1m_suffix() {
        assert_eq!(short_model_name("claude-opus-4.7-1m"), "opus-4.7-1m");
    }

    #[test]
    fn anthropic_dashed_version_with_date() {
        assert_eq!(short_model_name("claude-sonnet-4-5-20250929"), "sonnet-4.5");
    }

    #[test]
    fn gpt_passthrough() {
        assert_eq!(short_model_name("gpt-5.3-codex"), "gpt-5.3-codex");
    }

    #[test]
    fn gemini_passthrough() {
        assert_eq!(short_model_name("gemini-3.1-pro"), "gemini-3.1-pro");
    }

    #[test]
    fn unknown_raw() {
        assert_eq!(short_model_name("foo"), "foo");
    }

    // 新增:友好名格式
    #[test]
    fn friendly_sonnet_4_6_with_paren() {
        assert_eq!(
            short_model_name("Claude-Sonnet-4.6 (1M context)"),
            "sonnet-4.6-1m"
        );
    }

    #[test]
    fn friendly_opus_with_space_and_paren() {
        assert_eq!(short_model_name("Claude Opus 4.7 (1M)"), "opus-4.7-1m");
    }

    #[test]
    fn friendly_sonnet_4_6_default_200k() {
        // 没括号或括号里没 size token → 不加 suffix
        assert_eq!(short_model_name("Claude-Sonnet-4.6"), "sonnet-4.6");
    }

    #[test]
    fn anthropic_prefix_dotted() {
        assert_eq!(short_model_name("anthropic.claude-haiku-4.5"), "haiku-4.5");
    }

    // 已有 1m 在主体里 → 不重复加
    #[test]
    fn does_not_double_1m() {
        assert_eq!(
            short_model_name("Claude-Sonnet-4.6-1m (1M context)"),
            "sonnet-4.6-1m"
        );
    }

    // 200k 标签
    #[test]
    fn paren_200k_tag() {
        assert_eq!(
            short_model_name("Claude-Sonnet-4.6 (200K context)"),
            "sonnet-4.6-200k"
        );
    }

    // ── claude code 的 ver-tier 顺序(claude-<ver>-<tier>)
    #[test]
    fn claude_code_ver_tier_opus() {
        assert_eq!(short_model_name("claude-4.7-opus"), "opus-4.7");
    }

    #[test]
    fn claude_code_ver_tier_with_1m_suffix() {
        assert_eq!(short_model_name("claude-4.7-opus-1m"), "opus-4.7-1m");
    }

    #[test]
    fn claude_code_ver_tier_sonnet() {
        assert_eq!(short_model_name("claude-4.6-sonnet"), "sonnet-4.6");
    }

    #[test]
    fn claude_code_friendly_name_with_paren() {
        // 实际看到过的形式
        assert_eq!(
            short_model_name("Claude-4.7-Opus (1M context)"),
            "opus-4.7-1m"
        );
    }

    // ── 防御:模型名后跟了 note/警告文本
    #[test]
    fn strips_note_suffix_after_space() {
        assert_eq!(
            short_model_name("Claude-Opus-4.8-1M Note: the model was saved to user settings"),
            "opus-4.8-1m"
        );
    }

    #[test]
    fn strips_hyphenated_note_suffix() {
        assert_eq!(
            short_model_name(
                "opus-4.8-1m-note:-the-model-was-saved-to-user-settings,-but-the-project-\"model\"-setting-will-override-it-after-restart"
            ),
            "opus-4.8-1m"
        );
    }

    // 回归:codebuddy 偶发把带换行符的 note 塞进 requestModelName
    // 真实线上形态:`glm-5.2-ioa\nNote: The model was saved to user settings, ...`
    // 之前的 marker 列表只认 " note:"(空格前导),\n 不匹配 → 整段带换行的脏值
    // 被原样当 model 名注入 `--model` argv,子进程收到后异常。
    // 现在用「任意 ASCII 空白即截断」兜底。
    #[test]
    fn strips_note_suffix_after_newline() {
        assert_eq!(
            sanitize_model_name(
                "glm-5.2-ioa\nNote: The model was saved to user settings, but the project \"model\" setting will override it after restart. Remove the project \"model\" setting to persist this choice."
            ),
            "glm-5.2-ioa"
        );
        // \r\n 也算
        assert_eq!(sanitize_model_name("glm-5.2-ioa\r\nNote: x"), "glm-5.2-ioa");
        // \t 也算
        assert_eq!(sanitize_model_name("glm-5.2-ioa\tNote: x"), "glm-5.2-ioa");
        // 空格 + Note 仍然走老路径(回归保护)
        assert_eq!(
            sanitize_model_name("Claude-Opus-4.8-1M Note: The model was saved"),
            "Claude-Opus-4.8-1M"
        );
    }

    // 友好名 + 括号 size tag 仍然生效
    #[test]
    fn friendly_name_with_paren_still_works() {
        assert_eq!(
            short_model_name("Claude-4.7-Opus (1M context)"),
            "opus-4.7-1m"
        );
    }
}
