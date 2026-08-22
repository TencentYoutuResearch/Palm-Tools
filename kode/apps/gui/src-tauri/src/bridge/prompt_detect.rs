//! PTY-prompt 识别:从 vt100 已渲染的屏幕文本里推断子进程是否在等待用户输入。
//!
//! **2026-06:混合架构** — HookRelay 通过 Notification(permission_prompt) hook
//! 提供即时 attention 点亮信号,本模块的 detect() 作为内容补充提供结构化选项列表。
//! detect_mode() 保留作为 fallback(PreToolUse hook 优先)。suppress_until_ms 已移除。
//!
//! 设计:codebuddy / claude-code(claude-internal)CLI 都基于 Ink + SelectInput,
//! 有稳定的 prompt 形态:
//!
//! ```text
//! Do you want to proceed?
//! ❯ 1. Yes
//!   2. Yes, and don't ask again for ...
//!   3. No, and tell <CodeBuddy|Claude> what to do differently
//! ```
//!
//! 两套 CLI 共用 Ink 实现,差异仅在文案("CodeBuddy" vs "Claude"、"accept edits"
//! vs "auto-accept edits"),所以 detect 不依赖具体文案,只匹配:
//!   1. 行内含 "Do you want to" 且以 "?" 结尾(question 行)
//!   2. 紧跟连续的 "N. label" 行(选项)
//!   3. 至少有一行原文带 ❯ 或 > 光标(Ink SelectInput 必渲染,LLM markdown 没有)
//!   4. 选项之后到屏幕底之间没"杂文本"(bottom-anchored 检查)
//!
//! 已逆向 codebuddy bundle 确认:输入侧匹配正则 `/^[1-9]$/`,所以
//! 写一个数字字符就能选中对应选项,**无需** Enter / 方向键。claude 同样的 Ink
//! SelectInput,数字键直接选中。
//!
//! 我们不用 regex crate(workspace 里没引)— 直接 std 字符串扫描。
//! 速度足够,而且行级匹配比正则更容易读。

use kode_core::SessionId;

/// 协议 mode 枚举,与 codebuddy/claude `--permission-mode` 4 个值对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
}

impl PermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::BypassPermissions => "bypassPermissions",
            PermissionMode::Plan => "plan",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "default" => PermissionMode::Default,
            "acceptEdits" => PermissionMode::AcceptEdits,
            "bypassPermissions" => PermissionMode::BypassPermissions,
            "plan" => PermissionMode::Plan,
            _ => return None,
        })
    }
}

/// 从屏幕底部的 hint 行识别当前 PermissionMode。
///
/// 同时兼容 codebuddy 和 claude-code(claude-internal)两套文案 — 二者都基于 Ink,
/// hint 形态相同但具体字串略有差异:
///   codebuddy:
///     - `⏵⏵ accept edits on (shift+tab to cycle)`     → AcceptEdits
///     - `⏸ plan mode on (shift+tab to cycle)`          → Plan
///     - `⏵⏵ bypass permissions on (shift+tab to cycle)` → BypassPermissions
///   claude-code:
///     - `⏵⏵ auto-accept edits on (shift+tab to cycle)` → AcceptEdits(注意 "auto-")
///     - `⏸ plan mode on (shift+tab to cycle)`          → Plan(同)
///     - `⏵⏵ bypass permissions on (shift+tab to cycle)` → BypassPermissions(同)
///
/// 返回 None = 屏幕里没找到任何 hint 关键字(可能子进程刚启动还没渲染完)。
/// 调用方应保留之前已知的 mode 而不是覆盖为 Default。
pub fn detect_mode(screen: &str) -> Option<PermissionMode> {
    // 不区分 ANSI 颜色;直接关键字 contains
    if screen.contains("plan mode on") {
        return Some(PermissionMode::Plan);
    }
    // claude:"auto-accept edits on";codebuddy:"accept edits on"
    // 注意检查顺序:"auto-accept edits on" 也包含 "accept edits on" 子串,所以两个分支
    // 命中同一个 mode,顺序无所谓 — 但注释里说清楚兼容关系。
    if screen.contains("accept edits on") {
        return Some(PermissionMode::AcceptEdits);
    }
    if screen.contains("bypass permissions on") {
        return Some(PermissionMode::BypassPermissions);
    }
    // 看到 "shift+tab to" 但没有上面任何 hint → 显式 Default(底部 cycle 提示在但 mode 字面没出现)
    // 注意:codebuddy/claude 的 default 模式 *不* 显示 hint,所以这里实际几乎进不来 — 留个安全网
    if screen.contains("shift+tab to cycle") {
        return Some(PermissionMode::Default);
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedPrompt {
    pub header: String,
    /// "Do you want to proceed?" / "Do you want to make this edit to foo.rs?"
    pub question: String,
    pub options: Vec<DetectedOption>,
    /// 屏幕内容稳定 hash:同 prompt 反复扫描时去重用。
    pub dedup_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedOption {
    /// 用户看到的选项文本,已去掉前缀 "1. "
    pub label: String,
    /// 字符值(`"1"` / `"2"` / ...),POST /answer 时直接发这一个字节给 PTY
    pub value: String,
}

/// 每个 session 维护一份,用于去重 + tracking。
#[derive(Debug, Default, Clone)]
pub struct PromptState {
    /// 上次已 emit 的 dedup_key。同 key 不重复 emit。
    pub last_emitted: Option<String>,
    /// 上次已 emit 的 mode(string,以便 None 与 Default 不一样)。
    /// None = 还没 emit 过任何 mode。
    pub last_mode: Option<PermissionMode>,
    /// **当前屏幕上是否有 PTY-prompt 在等待回答**(scan_loop 维护)。
    /// 与 `last_emitted` 区分:`last_emitted` 是 emit 去重(子进程刚开始打印新字节
    /// 时会被 PTY-bytes router 清掉,这是正常的);`has_prompt` 真实反映"用户
    /// 还需要回应",只在 scan_loop 完整跑过一次后翻转。
    /// 翻转 false → true 时 emit `ask_user_question`(等价 last_emitted 翻转);
    /// 翻转 true → false(prompt 真的从屏幕上消失)时 emit `session.attention_cleared`,
    /// 让前端关掉脉冲动效。
    pub has_prompt: bool,
    /// 前端当前是否展示 ask attention。与 `has_prompt` 分开,因为 Codex
    /// PermissionRequest hook 会先于、甚至不经过 PTY detector 点亮 attention。
    /// 本地输入路径据此做乐观清除;扫描循环仍只用 `has_prompt` 判断屏幕 prompt。
    pub ask_attention_active: bool,
    /// JSONL `plan_proposed` 点亮、ExitPlanMode result / 屏幕 backstop 熄灭。
    /// `spawn_attention_forwarder` 用此标志做 ask/plan 优先级:
    /// plan 活跃时,同一 approval prompt 的 PTY `ask` 不点亮。
    /// 现在也由 HookRelay(PreToolUse) 和 scan_loop backstop 共同维护。
    pub plan_active: bool,
}

impl PromptState {
    /// 屏幕文字变了 / prompt 消失了 / 子进程开始打新输出 → 清空,允许下次再 emit。
    pub fn clear(&mut self) {
        self.last_emitted = None;
    }

    /// 只在第一次见到这个 prompt 时 emit。
    pub fn should_emit(&mut self, dedup_key: &str) -> bool {
        if self.last_emitted.as_deref() == Some(dedup_key) {
            return false;
        }
        self.last_emitted = Some(dedup_key.to_string());
        true
    }
}

/// 从 vt100 已渲染屏幕文本里识别 prompt。返回 None = 当前屏幕不是 prompt。
///
/// **要求**:调用方应保证 PTY idle ≥ ~300ms(屏幕已稳定)再调本函数,
/// 否则会在打印途中把"Do you want to..."这几个字符抓到不完整的状态。
///
/// 支持两种 prompt 形态:
///
/// **形态 A — Ink SelectInput(codebuddy/claude 标准 approval)**:
/// ```text
/// Do you want to proceed?
/// ❯ 1. Yes
///   2. Yes, and don't ask again
///   3. No, and tell CodeBuddy what to do differently
/// ```
///
/// **形态 B — kode box UI(DeferExecuteTool / MCP 权限确认)**:
/// ```text
/// ╭──────────────────╮
/// │ Confirm          │
/// │                  │
/// │   SomeTool       │
/// │   param: value   │
/// │                  │
/// │ > 1. Yes         │
/// │   2. Yes, and .. │
/// │   3. No, and ... │
/// │                  │
/// ╰──────────────────╯
/// Are you sure you want to do this?
/// ```
///
/// **关键约束**(防 false positive):prompt 永远 bottom-anchored。
pub fn detect(screen: &str) -> Option<DetectedPrompt> {
    // 先尝试形态 B(box UI),再尝试形态 A(标准 Ink SelectInput)
    detect_box_ui(screen).or_else(|| detect_ink_select(screen))
}

/// 形态 B:kode box UI 确认弹窗。
/// 特征:有 ╭─╮ / ╰─╯ 边框,选项行以 `│ > N.` 或 `│   N.` 开头。
fn detect_box_ui(screen: &str) -> Option<DetectedPrompt> {
    let lines = non_empty_screen_lines(screen);
    let total_lines = lines.len();

    // 从底部往上找 ╰ 闭合行
    let close_idx = lines.iter().rposition(|l| {
        let t = l.trim();
        t.starts_with('╰') && t.ends_with('╯')
    })?;

    // close 行必须在屏幕末段(允许后面跟几行说明文字)
    if total_lines.saturating_sub(close_idx) > 10 {
        return None;
    }

    // 从 close 往上找对应的 ╭ 开合行
    let open_idx = lines[..close_idx].iter().rposition(|l| {
        let t = l.trim();
        t.starts_with('╭') && t.ends_with('╮')
    })?;

    // box 内容:open_idx+1 .. close_idx
    let inner = &lines[open_idx + 1..close_idx];

    // 在 inner 里找带 `>` 或 `❯` 光标的选项行(即当前选中项)
    let mut has_select_cursor = false;
    let mut options: Vec<DetectedOption> = Vec::new();
    let mut header_text = String::from("Confirm");
    let mut header_seen = false;

    for line in inner {
        // 去掉 │ 前缀
        let stripped = strip_box_prefix(line);

        // 尝试识别选项行(带或不带光标前缀)
        let (has_cursor, opt_text) = if stripped.starts_with("> ") {
            (true, &stripped[2..])
        } else if stripped.starts_with("❯ ") {
            // ❯ is 3 bytes; "❯ " is 4 bytes total
            (true, &stripped[4..])
        } else {
            (false, stripped)
        };

        if let Some((digit, label)) = parse_numbered_option(opt_text) {
            if (1..=9).contains(&digit) {
                if has_cursor {
                    has_select_cursor = true;
                }
                options.push(DetectedOption {
                    label: label.to_string(),
                    value: digit.to_string(),
                });
            }
            continue;
        }

        // 取 box 第一个非空内容行作为 header(通常是 "Confirm" / "Warning" 等)
        let t = stripped.trim();
        if !t.is_empty() && options.is_empty() && !header_seen {
            // 排除纯边框或空行
            if !t
                .chars()
                .all(|c| matches!(c, '─' | '│' | '╭' | '╮' | '╯' | '╰' | ' '))
            {
                header_text = t.to_string();
                header_seen = true;
            }
        }
    }

    if options.len() < 2 || !has_select_cursor {
        return None;
    }

    // question:取 close 行后面的说明行,或 box 内第一行非空内容
    let question = lines
        .iter()
        .skip(close_idx + 1)
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| header_text.clone());

    let dedup_key = format!(
        "box|{}|{}|n={}",
        truncate_for_key(&header_text, 40),
        truncate_for_key(&options[0].label, 40),
        options.len()
    );

    Some(DetectedPrompt {
        header: header_text,
        question,
        options,
        dedup_key,
    })
}

/// 去掉 box UI 行的 │ 前缀和前后空格。
fn strip_box_prefix(line: &str) -> &str {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix('│') {
        rest.trim_end().strip_suffix('│').unwrap_or(rest).trim()
    } else {
        t
    }
}

/// 形态 A:codebuddy / claude 标准 Ink SelectInput prompt。
fn detect_ink_select(screen: &str) -> Option<DetectedPrompt> {
    // 1. 找 question 行 — 任何含 "Do you want to" 且以 "?" 结尾的行
    //    (Ink 渲染时这一行可能被光标符 / 颜色空格污染,所以做宽松 contains)
    //    要从屏幕**底部**往上找(rfind),只接受最靠下的那个,避免历史 prompt 误判。
    //
    //    **bottom-anchored 第一道**:question 行所在位置必须在屏幕末段。Ink 的
    //    SelectInput 总是渲染在终端底部 ~25 行可视区域内;真 prompt 出现时,
    //    question 行 + N 选项 + 几行 hint 总共占不到 ~25 行,所以 question 行
    //    距离屏幕底不该超过 25 行。如果 question 在屏幕中段、后面还有大量内容,
    //    那一定是 LLM markdown 文本里的列表(它用了 ❯ 也无所谓 — 光标在底部位置)。
    let lines = non_empty_screen_lines(screen);
    let total_lines = lines.len();
    let q_idx = lines.iter().rposition(|l| line_contains_question(l))?;
    // question 行距离屏幕底不能超过 25 行(典型终端可视区高度)
    const MAX_DISTANCE_FROM_BOTTOM: usize = 25;
    if total_lines.saturating_sub(q_idx) > MAX_DISTANCE_FROM_BOTTOM {
        return None;
    }
    let question_line = lines[q_idx].trim().to_string();
    let question = clean_question(&question_line)?;

    // 2. 在 question 行后面找连续的 "N. <label>" 行
    //    同时记录:**至少有一行的原文**(strip 之前)以 ❯ 光标开头。
    //    这是 Ink SelectInput 的硬特征:它**总是**在当前选中项前面渲染一个光标符号。
    //    LLM 输出的 markdown 列表不会有这个 — 这是区分真 prompt vs 文本误判最强的信号。
    //
    //    **更强约束**:question 行后**第一个非空行必须就是带 ❯ 的选项行**。
    //    Ink SelectInput 的实际渲染是 question 紧跟 `❯ 1. xxx`,中间不允许任何文本行。
    //    LLM markdown 通常会在 question 后插入一段说明 / 总结再列出 1./2./3.,
    //    这种就被这一道挡住。
    let mut options: Vec<DetectedOption> = Vec::new();
    let mut last_option_line_idx = q_idx;
    let mut has_select_cursor = false;
    let mut seen_first_non_empty_after_q = false;
    for (offset, line) in lines.iter().enumerate().skip(q_idx + 1) {
        let stripped = strip_ink_prefix(line);
        // 第一个非空行必须就是 numbered option — 不允许中间插入说明文字。
        // (注意:❯ 光标在用户箭头键操作后会移到任意选项,所以这里**只**约束
        //  "是否 numbered",不约束"是否在第 1 项上"。光标存在性由后面 has_select_cursor 全局检查。)
        if !seen_first_non_empty_after_q {
            if stripped.trim().is_empty() {
                continue;
            }
            seen_first_non_empty_after_q = true;
            if parse_numbered_option(stripped).is_none() {
                return None;
            }
        }
        if let Some((digit, label)) = parse_numbered_option(stripped) {
            // 限制 1..=9,符合 codebuddy bundle 里的 `/^[1-9]$/`
            if (1..=9).contains(&digit) {
                options.push(DetectedOption {
                    label: label.to_string(),
                    value: digit.to_string(),
                });
                last_option_line_idx = offset;
                // 检查这一行原文(未 strip)是否带光标 ❯ / >
                // 注意 strip_ink_prefix 之前的行,可能开头是空格 + ❯ + 空格 + "1. xxx"
                if line_starts_with_select_cursor(line) {
                    has_select_cursor = true;
                }
            }
            continue;
        }
        // 选项收集中遇到非选项行 — 如果还没收够 ≥ 2 个,说明只是 prompt 上方的描述行
        // 还在搜索状态;但若已经收到 ≥ 1 个并且这一行是空的或截断符,就停。
        if !options.is_empty() && stripped.trim().is_empty() {
            break;
        }
    }

    if options.len() < 2 {
        return None;
    }

    // **关键硬约束**:必须看到至少一个选项前有 ❯/> 光标。
    // Ink SelectInput 强制渲染光标(初始 focused index = 0,所以第 1 个选项一定有);
    // LLM 写的 markdown 编号列表不会有 ❯,只是一串 "1. ... 2. ..."。
    if !has_select_cursor {
        return None;
    }

    // 3. **bottom-anchored 检查**:最后一个选项之后,屏幕剩余行不允许有"杂文本"。
    //    允许:空行、纯装饰行(Ink 边框 / hint 文案如 "shift+tab to" 等)。
    //    禁止:任何看起来像 LLM 普通输出的非空行 — 这种情况说明命中的不是真 prompt,
    //    而是 LLM 对话里的 markdown 列表。
    //
    //    判定"杂文本":行去除装饰前缀后非空,且不属于已知的 Ink hint 文案。
    for line in lines.iter().skip(last_option_line_idx + 1) {
        let stripped = strip_ink_prefix(line).trim();
        if stripped.is_empty() {
            continue;
        }
        if is_ink_decoration_line(stripped) {
            continue;
        }
        // 看到了真正的"普通文本" → 这不是 bottom-anchored 的 Ink select prompt
        return None;
    }

    // 4. dedup_key:question + 第一个选项 label;不会因屏幕滚动 / 光标移动反复触发
    let dedup_key = format!(
        "{}|{}|n={}",
        truncate_for_key(&question, 80),
        truncate_for_key(&options[0].label, 60),
        options.len()
    );

    // header:取 "Do you want to <verb>" 中 verb 的第一段
    let header = derive_header(&question);

    Some(DetectedPrompt {
        header,
        question,
        options,
        dedup_key,
    })
}

/// 已知的 Ink hint / 装饰文案 — 出现在 prompt 之后到屏幕底之间是合法的。
/// 这是白名单:prompt 真在底部时 codebuddy / claude 会渲染这些 hint;LLM 文本里
/// 几乎不会同时出现这些字符串,所以反向证明"这是真 prompt"。
fn is_ink_decoration_line(s: &str) -> bool {
    // 全是 ─ │ ╭ ╮ ╯ ╰ 类边框字符
    if s.chars().all(|c| {
        matches!(
            c,
            '─' | '│' | '╭' | '╮' | '╯' | '╰' | '┌' | '┐' | '└' | '┘' | '·' | ' '
        )
    }) {
        return true;
    }
    // codebuddy / claude 共用的快捷键提示文案(命令栏底部 hint)
    let lower = s.to_ascii_lowercase();
    lower.contains("shift+tab")
        || lower.contains("ctrl+c to ")
        || lower.contains("esc to ")
        || lower.contains("(shift+tab")
        || lower.contains("plan mode")
        || lower.contains("accept edits")    // 含 "auto-accept edits"(claude)
        || lower.contains("bypass permissions")
        // codebuddy / claude "Press Enter to confirm" / "Press Enter to continue" hint
        || lower.contains("press enter")
        || lower.contains("press tab")
        // PermissionMode hint 的 "⏵⏵" / "⏸" + 文案,以及光标占位符
        || lower.starts_with("?")
        || lower.starts_with("❯")
}

/// 检查一行是否以 Ink SelectInput 光标开头。容许行首任意空格。
///
/// 接受两种光标:
/// - `❯` (U+276F) — Ink 默认光标,大多数现代终端
/// - `>` (ASCII)  — 部分环境(SSH 转发、降级终端、某些 vt100 模拟)下 codebuddy/claude
///                  会 ASCII fallback。实测 codebuddy v3.x bundle 内置 SelectInput
///                  在某些环境下直接渲染 `> 1. Yes` 这种形态。
///
/// 担心 `>` 误中 markdown blockquote / shell prompt:不会。本函数**只**在 detect()
/// 已经命中 question 行(`Do you want to...?`)+ 至少 2 个紧邻 numbered options
/// + bottom-anchored 三道过滤之后被调用,blockquote 不可能凑齐这套整体形态。
fn line_starts_with_select_cursor(line: &str) -> bool {
    let trimmed = line.trim_start();
    // ❯ 后必须跟空白
    if let Some(rest) = trimmed.strip_prefix('❯') {
        return rest.starts_with(' ') || rest.starts_with('\t');
    }
    // ASCII '>' fallback — 同样要求后接空白,避免命中 ">>" / ">word" 这类
    if let Some(rest) = trimmed.strip_prefix('>') {
        return rest.starts_with(' ') || rest.starts_with('\t');
    }
    false
}

/// 同 detect,但带 session_id 给日志用(方便定位是哪个 tab)。
#[allow(dead_code)]
pub fn detect_for(id: SessionId, screen: &str) -> Option<DetectedPrompt> {
    let r = detect(screen);
    if r.is_none() {
        tracing::trace!(%id, len = screen.len(), "no prompt detected");
    } else {
        tracing::debug!(%id, ?r, "prompt detected");
    }
    r
}

// ============================================================================
// helpers
// ============================================================================

fn line_contains_question(line: &str) -> bool {
    // codebuddy / claude 的 approval prompt 文案稳定以 "Do you want to" 开头
    // (e.g. "Do you want to proceed?", "Do you want to make this edit to foo.rs?")
    let l = line.trim_start();
    let l = strip_ink_prefix(l);
    l.contains("Do you want to") && l.trim_end().ends_with('?')
}

fn non_empty_screen_lines(screen: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = screen.lines().collect();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines
}

/// 把行首的 Ink 装饰前缀剥掉:可能是 `❯`、`>`、`│`、空格,任意组合。
fn strip_ink_prefix(line: &str) -> &str {
    let trimmed = line.trim_start_matches(|c: char| {
        c.is_whitespace() || matches!(c, '❯' | '>' | '│' | '·' | '*' | '•' | '─')
    });
    trimmed
}

fn clean_question(line: &str) -> Option<String> {
    // 去掉前后装饰、剩下就是问题
    let s = strip_ink_prefix(line).trim();
    if s.is_empty() {
        return None;
    }
    Some(s.to_string())
}

/// 解析 "1. Yes" / " 2.   No, and ..." 这类行。返回 (digit, label)
fn parse_numbered_option(line: &str) -> Option<(u32, &str)> {
    let trimmed = line.trim_start();
    // 第一段必须是连续数字
    let (num_str, rest) = trimmed
        .find(|c: char| !c.is_ascii_digit())
        .map(|i| trimmed.split_at(i))?;
    if num_str.is_empty() {
        return None;
    }
    // 数字后面必须紧跟 ". " 或 "."
    let rest = rest.strip_prefix('.')?;
    let label = rest.trim_start();
    if label.is_empty() {
        return None;
    }
    let digit: u32 = num_str.parse().ok()?;
    // label 末端的多余空格 / unicode 装饰也修一下
    let label = label.trim_end();
    Some((digit, label))
}

fn truncate_for_key(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// 从 question 文本里生成 header(用于 Flutter 卡片小标题)。
/// "Do you want to proceed?" → "Approval"
/// "Do you want to make this edit to foo.rs?" → "Edit foo.rs"
fn derive_header(question: &str) -> String {
    let lower = question.to_ascii_lowercase();
    if lower.contains("make this edit") || lower.contains("multi edit") {
        return "Edit approval".to_string();
    }
    if lower.contains("create") {
        return "Create approval".to_string();
    }
    if lower.contains("fetch") {
        return "Fetch approval".to_string();
    }
    if lower.contains("proceed") {
        return "Bash approval".to_string();
    }
    "Approval".to_string()
}

// ============================================================================
// tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// codebuddy 真实渲染样本(Bash approval)
    /// 每行末尾的空格代表 vt100 padding 到 cols 宽度,detect 应该容忍。
    const SAMPLE_BASH_APPROVAL: &str = "\
$ git diff HEAD apps/gui/src-tauri/src/bridge/semantic.rs

  Bash command
  cd /Users/tester/Projects/example/kode && git diff HEAD apps/gui/src...
  看 semantic.rs 全部 diff

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for git diff commands in /Users/tester/Projects/example/kode
  3. No, and tell CodeBuddy what to do differently

  Press Enter to confirm
";

    const SAMPLE_EDIT_APPROVAL: &str = "\
Edit foo.rs

Do you want to make this edit to foo.rs?
❯ 1. Yes
  2. Yes, allow editing in this directory during this session
  3. No, and tell CodeBuddy what to do differently
";

    /// claude-code(claude-internal)真实渲染样本 — 与 codebuddy 同形态,但
    /// "tell Claude" 而非 "tell CodeBuddy"。底部 hint 也有差异:claude 用
    /// "auto-accept edits on" 而 codebuddy 用 "accept edits on"。
    const SAMPLE_CLAUDE_BASH_APPROVAL: &str = "\
$ git status

  Bash command
  git status -uno
  show working tree status

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for git status commands
  3. No, and tell Claude what to do differently
";

    const SAMPLE_CLAUDE_EDIT_APPROVAL: &str = "\
Edit foo.rs

Do you want to make this edit to foo.rs?
❯ 1. Yes
  2. Yes, allow editing in this directory during this session
  3. No, and tell Claude what to do differently
";

    const SAMPLE_PROCEEDING_LOG: &str = "\
Running cargo build...
   Compiling foo v0.1.0
   Finished `dev` profile [optimized + debuginfo] target(s) in 1.23s
Done.
";

    /// codebuddy 在某些环境(SSH 转发 / 降级终端 / 部分 vt100 模拟)下,SelectInput
    /// 把光标降级渲染成 ASCII `>` 而非 `❯`。这是真实抓到的 dev log 屏幕样本(2026-05-30)。
    /// detector 必须同时识别 `>` 形态,否则黄色"待用户回应"提示永远点不亮。
    const SAMPLE_ASCII_CURSOR_BASH_APPROVAL: &str = "\
$ npm install

  Bash command
  npm install some-package
  install package

Do you want to proceed?
> 1. Yes
  2. Yes, and don't ask again for session (shift + tab)
  3. No, and tell CodeBuddy what to do differently (escape)
";

    #[test]
    fn detects_bash_approval_prompt() {
        let r = detect(SAMPLE_BASH_APPROVAL).expect("should detect");
        assert!(
            r.question.contains("Do you want to proceed"),
            "question: {}",
            r.question
        );
        assert_eq!(r.options.len(), 3);
        assert_eq!(r.options[0].value, "1");
        assert_eq!(r.options[0].label, "Yes");
        assert_eq!(r.options[1].value, "2");
        assert!(r.options[1].label.starts_with("Yes,"));
        assert_eq!(r.options[2].value, "3");
        assert!(r.options[2].label.starts_with("No,"));
        assert_eq!(r.header, "Bash approval");
    }

    /// 实测 codebuddy 部分环境下 SelectInput 把光标降级成 ASCII `>`(参考样本注释)。
    /// 这是真实捕获的 dev log 形态;regression 测试,防止再次把 `>` cursor 拒绝掉。
    #[test]
    fn detects_ascii_cursor_approval_prompt() {
        let r = detect(SAMPLE_ASCII_CURSOR_BASH_APPROVAL)
            .expect("ASCII '>' cursor must be recognized as Ink SelectInput");
        assert!(r.question.contains("Do you want to proceed"));
        assert_eq!(r.options.len(), 3);
        assert_eq!(r.options[0].value, "1");
        assert_eq!(r.options[0].label, "Yes");
    }

    #[test]
    fn detects_edit_approval_prompt() {
        let r = detect(SAMPLE_EDIT_APPROVAL).expect("should detect");
        assert!(r.question.contains("make this edit"));
        assert_eq!(r.options.len(), 3);
        assert_eq!(r.header, "Edit approval");
    }

    #[test]
    fn detects_claude_bash_approval_prompt() {
        // claude-code 文案("tell Claude")应被正确识别 — 我们不依赖具体后端文案,
        // 只看 Ink select 的形态(Do you want to + 编号 + ❯ 光标)。
        let r = detect(SAMPLE_CLAUDE_BASH_APPROVAL).expect("should detect claude prompt");
        assert!(r.question.contains("Do you want to proceed"));
        assert_eq!(r.options.len(), 3);
        assert_eq!(r.options[0].value, "1");
        assert_eq!(r.options[0].label, "Yes");
        assert!(r.options[2].label.contains("tell Claude"));
        assert_eq!(r.header, "Bash approval");
    }

    #[test]
    fn detects_claude_edit_approval_prompt() {
        let r = detect(SAMPLE_CLAUDE_EDIT_APPROVAL).expect("should detect claude prompt");
        assert!(r.question.contains("make this edit"));
        assert_eq!(r.options.len(), 3);
        assert_eq!(r.header, "Edit approval");
    }

    #[test]
    fn detect_mode_finds_claude_auto_accept_edits() {
        // claude 用 "auto-accept edits on";codebuddy 用 "accept edits on"
        // 两者都该映射到 PermissionMode::AcceptEdits
        let screen = "...\n  ⏵⏵ auto-accept edits on (shift+tab to cycle)\n";
        assert_eq!(detect_mode(screen), Some(PermissionMode::AcceptEdits));
    }

    #[test]
    fn no_match_on_normal_log() {
        assert!(detect(SAMPLE_PROCEEDING_LOG).is_none());
    }

    #[test]
    fn no_match_when_options_too_few() {
        // 只有 1 个 "1. ..." 行 — 不够 2 个,不算 prompt
        let s = "Do you want to proceed?\n  1. Yes\n";
        assert!(detect(s).is_none());
    }

    #[test]
    fn requires_question_mark() {
        // 没有 "?" 不该误中
        let s = "Do you want to maybe.\n  1. Yes\n  2. No\n";
        assert!(detect(s).is_none());
    }

    #[test]
    fn no_false_positive_in_llm_markdown_without_cursor() {
        // LLM 输出的 markdown 列表,**没有** ❯ 光标 — 即使后面没有杂文本也不该触发
        let s = "Here are the options:\n\
            Do you want to proceed?\n\
            1. Yes, do it\n\
            2. No, abort\n";
        assert!(
            detect(s).is_none(),
            "LLM markdown without ❯ cursor must not trigger"
        );
    }

    #[test]
    fn no_false_positive_in_llm_markdown() {
        // LLM 输出里包含 "Do you want to ...?" 后跟数字列表,但下面还有正常文字
        // 这种情况 prompt 已经不在屏幕底部 — 应**不**触发。
        let s = "Sure! Here's what I'd ask:\n\
            Do you want to proceed?\n\
            1. Yes, do it\n\
            2. No, abort\n\
            \n\
            Anyway, I'll go ahead and analyze the file first...\n\
            (continues with actual work)\n";
        assert!(
            detect(s).is_none(),
            "should not match when normal text follows the option list"
        );
    }

    #[test]
    fn no_false_positive_when_prompt_is_history() {
        // 老 prompt + 新输出推下去:屏幕里有 "Do you want to ...?" 但已经被新内容隔开
        let s = "...\n\
            Do you want to delete this file?\n\
            1. Yes\n\
            2. No\n\
            \n\
            > User chose 2.\n\
            Tool ran successfully.\n\
            Final answer: 42\n";
        assert!(
            detect(s).is_none(),
            "history prompt should not trigger when newer output exists below"
        );
    }

    #[test]
    fn matches_real_bottom_anchored_prompt() {
        // codebuddy 真实 prompt:question + options + Ink hint(快捷键提示)
        let s = "...some context...\n\
            \n\
            Do you want to make this edit to foo.rs?\n\
            ❯ 1. Yes\n\
              2. No, and tell me what to do\n\
            \n\
              ╭──────────────────────────╮\n\
              shift+tab to switch modes\n";
        assert!(
            detect(s).is_some(),
            "real bottom-anchored Ink select should still match"
        );
    }

    /// kode box UI 确认弹窗样本 — DeferExecuteTool / MCP 权限确认的真实渲染形态
    const SAMPLE_BOX_UI_CONFIRM: &str = "\
● DeferExecuteTool(mcp__memory__memory_search)
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Confirm                                                                                                    │
│                                                                                                            │
│   DeferExecuteTool                                                                                         │
│   toolName: \"mcp__memory__memory_search\", params: {\"query\":\"flutter bridge PTY input enter submit          │
│   Ink\",\"scope\":\"project:kode\",\"top_k\":5}                                                                 │
│                                                                                                            │
│ > 1. Yes                                                                                                   │
│   2. Yes, and don't ask again this session (shift + tab)                                                   │
│   3. No, and tell CodeBuddy what to do differently (escape)                                                │
│                                                                                                            │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
Are you sure you want to do this?
";

    #[test]
    fn detects_box_ui_confirm_prompt() {
        let r = detect(SAMPLE_BOX_UI_CONFIRM).expect("box UI confirm must be detected");
        assert_eq!(r.header, "Confirm");
        assert_eq!(r.options.len(), 3);
        assert_eq!(r.options[0].value, "1");
        assert_eq!(r.options[0].label, "Yes");
        assert_eq!(r.options[1].value, "2");
        assert!(r.options[1].label.contains("don't ask again"));
        assert_eq!(r.options[2].value, "3");
        assert!(r.options[2].label.contains("No,"));
        assert!(r.question.contains("Are you sure"));
    }

    #[test]
    fn no_false_positive_box_without_cursor() {
        // box UI 但没有 > / ❯ 光标 — 不应触发
        let s = "\
╭──────────────╮
│ Confirm      │
│              │
│ 1. Yes       │
│ 2. No        │
│              │
╰──────────────╯
Are you sure?
";
        assert!(detect(s).is_none(), "box without cursor must not trigger");
    }

    #[test]
    fn parse_numbered_option_basic() {
        assert_eq!(parse_numbered_option("1. Yes"), Some((1, "Yes")));
        assert_eq!(
            parse_numbered_option("  2.   No, and tell CodeBuddy"),
            Some((2, "No, and tell CodeBuddy"))
        );
        assert_eq!(parse_numbered_option("foo"), None);
        assert_eq!(parse_numbered_option(""), None);
        assert_eq!(parse_numbered_option("3"), None);
    }

    #[test]
    fn strip_ink_prefix_handles_arrow_and_pipes() {
        assert_eq!(strip_ink_prefix("❯ 1. Yes"), "1. Yes");
        assert_eq!(strip_ink_prefix("│  > 2. No"), "2. No");
        assert_eq!(strip_ink_prefix("   3. Maybe"), "3. Maybe");
    }

    #[test]
    fn line_starts_with_select_cursor_recognizes_real_cursor() {
        // ❯ (U+276F) 是 Ink 默认光标 — 必须识别
        assert!(line_starts_with_select_cursor("❯ 1. Yes"));
        assert!(line_starts_with_select_cursor("  ❯ 1. Yes"));
        // ASCII '>' fallback — 实测 codebuddy 在某些环境下降级到这个形态(2026-05-30 dev log)。
        // 单看一行的话 markdown blockquote 也是这样,但 detect() 已经用 question + numbered options
        // 把整体形态卡死了,加 ASCII fallback 不会引入误报;反过来不加就直接漏报。
        assert!(line_starts_with_select_cursor("> 2. No"));
        assert!(line_starts_with_select_cursor("  > 3. Maybe"));
        // ❯ / > 后必须是空白 — 排除 ❯❯ / >> / >word 这类
        assert!(!line_starts_with_select_cursor("❯❯❯"));
        assert!(!line_starts_with_select_cursor(">>"));
        assert!(!line_starts_with_select_cursor(">word"));
        // 文本中的 ❯/> 不是行首
        assert!(!line_starts_with_select_cursor("foo ❯ bar"));
        assert!(!line_starts_with_select_cursor("foo > bar"));
        // 普通 markdown 列表不带光标
        assert!(!line_starts_with_select_cursor("1. Yes"));
        assert!(!line_starts_with_select_cursor("  1. Yes"));
    }

    #[test]
    fn no_false_positive_when_question_far_from_bottom() {
        // question 行距离屏幕底超过 25 行 → 即使带 ❯ 也不该触发(prompt 不可能在中段)
        let mut s = String::from("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
        for i in 0..30 {
            s.push_str(&format!("more output line {i}\n"));
        }
        assert!(
            detect(&s).is_none(),
            "question far from bottom should not trigger"
        );
    }

    #[test]
    fn no_false_positive_with_text_between_question_and_options() {
        // LLM 常见形态:question 行后插入一段说明,再列编号选项 — Ink 不会这样渲染。
        // 即使后面带 ❯,也不该触发。
        let s = "\
Do you want to proceed?
Here's some context to help you decide:
This will modify your config file.
❯ 1. Yes
  2. No
";
        assert!(
            detect(s).is_none(),
            "explanatory text between question and options should not trigger"
        );
    }

    #[test]
    fn dedup_key_stable_across_cursor_changes() {
        // ❯ 在第 1 个选项 vs 第 2 个选项时,屏幕实际不同(箭头位置变了)
        // 但 dedup_key 应该一致(因为我们 strip 掉了 ❯,只看 question + 第一选项 label)
        let s1 = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
        let s2 = "Do you want to proceed?\n  1. Yes\n❯ 2. No\n";
        let r1 = detect(s1).unwrap();
        let r2 = detect(s2).unwrap();
        assert_eq!(r1.dedup_key, r2.dedup_key);
    }

    #[test]
    fn prompt_state_dedup() {
        let mut state = PromptState::default();
        assert!(state.should_emit("k1"));
        assert!(!state.should_emit("k1"));
        assert!(state.should_emit("k2"));
        state.clear();
        assert!(state.should_emit("k2"));
    }

    #[test]
    fn detect_mode_finds_plan() {
        let screen = "...some output...\n  ⏸ plan mode on (shift+tab to cycle)\n";
        assert_eq!(detect_mode(screen), Some(PermissionMode::Plan));
    }

    #[test]
    fn detect_mode_finds_accept_edits() {
        let screen = "...\n  ⏵⏵ accept edits on (shift+tab to cycle)\n";
        assert_eq!(detect_mode(screen), Some(PermissionMode::AcceptEdits));
    }

    #[test]
    fn detect_mode_finds_bypass() {
        let screen = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
        assert_eq!(detect_mode(screen), Some(PermissionMode::BypassPermissions));
    }

    #[test]
    fn detect_mode_no_hint_returns_none() {
        let screen = "regular output, no permission hint here\n";
        assert_eq!(detect_mode(screen), None);
    }

    #[test]
    fn detect_mode_default_when_only_cycle_hint() {
        let screen = "(shift+tab to cycle)";
        assert_eq!(detect_mode(screen), Some(PermissionMode::Default));
    }

    #[test]
    fn permission_mode_str_round_trip() {
        for m in [
            PermissionMode::Default,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
            PermissionMode::Plan,
        ] {
            assert_eq!(PermissionMode::from_str(m.as_str()), Some(m));
        }
        assert_eq!(PermissionMode::from_str("garbage"), None);
    }

    #[test]
    fn plan_state_default_inactive() {
        let s = PromptState::default();
        assert!(!s.plan_active, "plan_active should default to false");
        assert!(
            !s.ask_attention_active,
            "ask_attention_active should default to false"
        );
    }
}
