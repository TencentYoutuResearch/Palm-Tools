//! 注入到 codebuddy / claude / claude-internal 子进程 system prompt 末尾的指令段。
//!
//! 设计原则(改前先读):
//!
//! 1. **prompt-only 方案**:不监听文件、不做镜像、不调 LLM。所有"无痕同步"的
//!    业务效果靠 agent 自己**主动调** `memory_search` / `memory_propose` 实现 ——
//!    这两个工具来自 kode-memory MCP server,所有 backend 共用同一个池。
//!
//! 2. **<kode-memory> XML 标签包**:让 agent 容易识别这段是 kode 框架注入的、
//!    跟项目 CLAUDE.md / CODEBUDDY.md 区分开。
//!
//! 3. **占位符消歧**:`{{BACKEND}}` / `{{SCOPE}}` 在 build 时替换成具体值,
//!    让 agent 拿到的 prompt 里直接写好 `author="claude-internal"` /
//!    `scope="project:kode"`,不需要它自己推断 —— 实测 LLM 对 cwd-slug
//!    的推断会出现 `kode` / `youtu-app-kode` / 全路径三种结果,
//!    导致 search 时对不上。
//!
//! 4. **trigger 规则只放最关键的几条**:具体"何时调"细化到 tool description
//!    (热路径,工具列表每次都呈现);prompt 模板(冷启动,跳读)只点关键场景。
//!
//! 5. **能量预算用常量,不写死数字**:从 `budget` 模块取 `COST_PROPOSE` /
//!    `REWARD_APPROVE` / `PENALTY_REJECT`,改 budget 时 prompt 不会过期。
//!
//! 6. **deferred 工具警告(2026-06)**:`memory_search` / `memory_propose` 在 codebuddy /
//!    claude 等 backend 里通常被打成 deferred(懒加载),默认不在活跃工具集 —— 直接调
//!    会返回「找不到工具」。**prompt 必须明示**第一次用前要跑 `ToolSearch(...)`
//!    把 schema 拉进来。否则 agent 会"看不到工具就走自家文件系统 auto-memory"
//!    (`~/.codebuddy/projects/.../memory/*.md`),完全绕过 kode-memory 池。
//!
//! 7. **跟 backend file-based auto-memory 共存(2026-06)**:不禁用 backend 自家的
//!    文件系统 memory,而是给两者明确**分工**:
//!    - **kode-memory MCP**(本模板) = 跨 tab / 跨 backend 的**共享**项目级 wiki
//!    - **backend file-based** = 本 backend 私有的**临时 working notes**
//!    判定规则在模板里写明「别人会受益吗?」让 agent 自己决策。这样既不浪费 backend
//!    内置能力,又防止跨 tab 的经验被锁在某个 backend 文件夹里。
//!    MCP 不可用时,prompt 要求 agent **明确告知用户** 它降级到了私有 memory,
//!    而不是悄悄走文件系统 —— 让用户能主动切到能用 MCP 的 tab。

use std::path::Path;

/// 由 `cwd` 推 project slug:取最后一段目录名。
///
/// 选 basename 而不是哈希/全路径有两个理由:
/// 1. **可读**:`project:kode` 比 `project:a3f2...` 强
/// 2. **跟 baseline / e2e 测试一致**:仓库里现有 fact scope 都是 `project:<basename>`
///    形态(`project:kode`, `project:kode`),换算法会让旧 fact 全部对不上
///
/// **已知风险**:两个不同路径但最后一段重名的项目会撞 scope。MVP 不处理 —— 真撞了
/// 用户会立刻发现(无关 fact 召回),那时再加哈希后缀。
fn project_slug(cwd: &Path) -> Option<String> {
    cwd.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// 构建注入到子进程 system prompt 的指令段。
///
/// 参数全部用上 —— `backend_key` 替换 `{{BACKEND}}`,`cwd` 推 slug 替换 `{{SCOPE}}`。
/// cwd 取不到合法 basename(eg. 根目录 / 空 Path)时,fallback 用 `shared`,并在
/// prompt 里告诉 agent "本次没识别出项目,默认走 shared 池"。
///
/// **未知 backend → 返回空字符串**:kode-memory 的 prompt 设计前提是 backend 是
/// 一个 LLM agent CLI(codebuddy / claude / claude-internal),它要能理解
/// `--append-system-prompt` 这种 flag。给非 LLM backend(比如测试用的 `/bin/cat`、
/// 或用户自己加的 raw shell)注入一个长 prompt 是错的:
/// - cat 之类的命令不认 flag 会立刻 exit 1
/// - 即使认,prompt 也无意义
/// Codex CLI 不支持 `--append-system-prompt`,但 Codex hooks 的 SessionStart
/// 会复用本模板作为 additional developer context。
///
/// 所以这里显式 allowlist 已知 LLM backend,其它一律 return "" 让
/// `inject_kode_memory_prompt` 的"prompt 空时短路"逻辑接手。
pub fn build(cwd: &Path, backend_key: &str) -> String {
    if !is_supported_backend(backend_key) {
        return String::new();
    }
    let (scope, scope_note) = match project_slug(cwd) {
        Some(s) => (format!("project:{s}"), String::new()),
        None => (
            "shared".to_string(),
            "(本次未能从 cwd 识别出项目名,默认 scope=shared,如果你判断这是个项目请改 project:<name>)\n".to_string(),
        ),
    };
    let project_path = cwd.to_string_lossy().to_string();
    PROMPT_TEMPLATE
        .replace("{{BACKEND}}", backend_key)
        .replace("{{SCOPE}}", &scope)
        .replace("{{PROJECT_PATH}}", &project_path)
        .replace("{{SCOPE_NOTE}}", &scope_note)
        .trim_start()
        .to_string()
}

/// kode-memory prompt 模板适用的 LLM agent backend。
/// CLI 是否注入 `--append-system-prompt` 由 `BackendProfile::supports_append_system_prompt`
/// 决定;这里只控制 prompt 文本本身(Codex SessionStart hook 仍会复用本模板)。
fn is_supported_backend(backend_key: &str) -> bool {
    matches!(
        backend_key,
        "codebuddy" | "claude" | "claude-internal" | "codex"
    )
}

const PROMPT_TEMPLATE: &str = r#"
<kode-memory>
你在 `kode` 内运行,backend=`{{BACKEND}}`。所有 tab 共用一个 memory 池(MCP `memory`),
scope=`{{SCOPE}}`,项目路径=`{{PROJECT_PATH}}`。{{SCOPE_NOTE}}

## session 启动时立即执行(强制)

**收到用户第一条消息之前**,先跑:
```
ToolSearch("memory_search")   // 拉 schema
memory_search(query="{{SCOPE}}", scope="{{SCOPE}}", top_k=20)
```
把返回的 facts 静默加载进上下文 —— 不需要向用户汇报"我在搜记忆"。
如果返回空,继续正常响应;如果 MCP 不可用,告知用户后继续。

## 何时调 memory MCP

**先搜后答**(任一命中):

0. **用户问"有哪些 memory""记了什么""recall"等查阅类问题时，先 `memory_search` 再读 file-based 
  `MEMORY.md`，合并展示**
1. 用户问偏好/规范类问题:「能不能 X / 禁不禁止 X / 这项目的风格是 / 用 X 还是 Y」
2. 用户显式指令:「记住 / 以后都这样 / 这个规范 / 别再 X / 总结一下」
3. 改某模块前(搜模块名)、调试前(搜报错文本)、回答「为什么这样」前
4. 用户对架构 / 工具链 / UI 风格 / 配置做了拍板决策

**不触发**:明确的一次性指令(「这次先 X」)、能从代码或 git log 直接看出来的事实。

## 跟 backend file-based auto-memory 的分工

- 用户显式说「记住」→ MCP `memory`(本规则)
- **用户查阅"有哪些 memory"时 → 先搜 MCP，再读 file-based，合并展示**

## 调用要点

- **search**:`memory_search(query=用户原话关键词, scope="{{SCOPE}}")`
- **propose**:`memory_propose(author="{{BACKEND}}", scope="{{SCOPE}}", title=短英文标题, body=结论+why, tags=[...], confidence≈0.8)`
- 第一次用 deferred 工具:`ToolSearch("memory_search")` 拉 schema(否则报「找不到工具」)
- 遇 duplicate:看返回的 candidates → 同名跳过 / 过时 supersede / 词汇撞车 force=true / 不确定问用户
- 遇 `out_of_energy`:告诉用户,别硬塞
- 发现矛盾:`memory_propose(supersedes=<id>)` 提议替换,别瞒报
</kode-memory>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// session 启动时必须有强制 memory_search 指令 —— 这是"无感知预加载 memory"的入口。
    #[test]
    fn template_has_startup_search_instruction() {
        let p = build(&PathBuf::from("/x/myproj"), "codebuddy");
        assert!(
            p.contains("session 启动时") || p.contains("第一条消息之前"),
            "must instruct agent to run memory_search before first user message"
        );
        // scope 占位符必须被替换成真实 scope,确保搜索命中正确 pool
        assert!(
            p.contains("project:myproj"),
            "startup search query must use the resolved scope, got:\n{p}"
        );
    }

    /// 模板必须含 <kode-memory> 起止标签 —— 这是 agent 识别"哪段是 kode 注入"的契约。
    #[test]
    fn template_has_kode_memory_xml_tags() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(p.contains("<kode-memory>"), "missing opening tag");
        assert!(p.contains("</kode-memory>"), "missing closing tag");
    }

    /// 模板必须显式提到工具名,否则 agent 可能不知道有这俩 MCP 工具能调。
    #[test]
    fn template_references_both_mcp_tools() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(p.contains("memory_search"), "must mention memory_search");
        assert!(p.contains("memory_propose"), "must mention memory_propose");
    }

    /// 模板必须提到 out_of_energy —— 否则 agent 收到这个错误码不知道含义。
    /// (具体扣分数字 2026-06 起不再写进模板,改由 MCP 错误返回告知;参见 ROADMAP)
    #[test]
    fn template_mentions_out_of_energy() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("out_of_energy"),
            "must mention out_of_energy so agent self-throttles when MCP returns it"
        );
    }

    /// build 必须把 backend_key 注入,而不是留 `<你的 backend 名>` 占位让 LLM 猜。
    #[test]
    fn template_substitutes_backend_key() {
        let p = build(&PathBuf::from("/tmp/kode"), "claude-internal");
        assert!(p.contains("claude-internal"), "backend not substituted");
        assert!(!p.contains("{{BACKEND}}"), "raw placeholder leaked");
    }

    /// build 必须把 cwd 转成 project:<basename> 并替换进模板。
    /// 这个测试锁住 P0 修复:LLM 不需要自己推 cwd-slug。
    #[test]
    fn template_substitutes_project_scope_from_cwd() {
        let p = build(&PathBuf::from("/Users/x/work/kode"), "codebuddy");
        assert!(
            p.contains("project:kode"),
            "scope not substituted from cwd basename, got prompt:\n{p}"
        );
        assert!(!p.contains("{{SCOPE}}"), "raw placeholder leaked");
        assert!(!p.contains("<cwd-slug>"), "old placeholder syntax leaked");
    }

    /// cwd 取不到 basename(空 Path / 根目录)时,scope fallback 到 shared
    /// 并在 prompt 里告知 agent。
    #[test]
    fn template_falls_back_to_shared_when_cwd_has_no_basename() {
        let p = build(Path::new(""), "codebuddy");
        assert!(
            p.contains("scope = `shared`")
                || p.contains("scope=`shared`")
                || p.contains("`shared`"),
            "should fall back to shared, prompt:\n{p}"
        );
        assert!(
            p.contains("未能从 cwd 识别出项目名"),
            "should warn agent about scope fallback"
        );
    }

    /// build 是确定性的(相同输入返回同一字符串)。锁住这条契约让 caller 能放心
    /// 把结果当 args 传 PtyHost::spawn(不会因调用时机有差异)。
    #[test]
    fn build_is_deterministic() {
        let a = build(&PathBuf::from("/x/proj"), "codebuddy");
        let b = build(&PathBuf::from("/x/proj"), "codebuddy");
        assert_eq!(a, b);
    }

    /// 不同 backend / cwd 必须得到不同的 prompt —— 否则参数其实没用上。
    #[test]
    fn build_varies_by_backend_and_cwd() {
        let a = build(&PathBuf::from("/x/proj-a"), "codebuddy");
        let b = build(&PathBuf::from("/x/proj-a"), "claude");
        let c = build(&PathBuf::from("/x/proj-b"), "codebuddy");
        assert_ne!(a, b, "backend should change prompt");
        assert_ne!(a, c, "cwd should change prompt");
    }

    /// 旧版措辞回归测试:不要怀疑/不确定就 shared 已删,新模板不含这些过时指令。
    #[test]
    fn template_does_not_have_removed_phrases() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            !p.contains("不要怀疑"),
            "removed: conflicts with supersedes flow"
        );
    }

    /// 模板必须告诉 agent 先 `ToolSearch` 才能调 deferred MCP tools。
    #[test]
    fn template_warns_about_deferred_tool_search() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("ToolSearch"),
            "must mention ToolSearch so agent knows to load deferred tools first"
        );
        assert!(
            p.contains("ToolSearch(\"memory_search\")"),
            "deferred discovery must use the bare tool name, got:\n{p}"
        );
        assert!(
            !p.contains("ToolSearch(tool_names=[\"mcp__memory__memory_search\"])"),
            "Codex deferred discovery does not match fully-qualified MCP names"
        );
    }

    /// 模板必须明确「kode-memory MCP」和「backend file-based auto-memory」是共存关系。
    #[test]
    fn template_describes_coexistence_with_backend_auto_memory() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("auto-memory") || p.contains("file-based") || p.contains("scratchpad"),
            "must reference backend's own file-based auto-memory"
        );
        assert!(
            p.contains("分工") || p.contains("互斥") || p.contains("不要双写"),
            "must explain the shared-vs-private split"
        );
    }

    /// 模板不应再有"禁用"backend 自家 memory 的措辞。
    #[test]
    fn template_does_not_forbid_backend_file_memory() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            !p.contains("禁用"),
            "user explicitly chose coexistence over banning backend file memory"
        );
    }

    /// MCP 不可用时,模板要求 agent 告知用户,别悄悄退到私有 memory。
    #[test]
    fn template_requires_telling_user_when_mcp_unavailable() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("不可用") || p.contains("MCP 不可用"),
            "must instruct agent to tell user when MCP is down"
        );
    }

    /// 模板必须列出触发规则(偏好/规范、显式指令、模块改动前、拍板决策)
    /// 让 agent 知道**何时**主动调 kode-memory MCP。
    #[test]
    fn template_has_hard_rule_for_user_preferences_and_conventions() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("先搜后答") || p.contains("何时调"),
            "must explicitly state when to call memory MCP"
        );
        assert!(
            p.contains("偏好") || p.contains("规范"),
            "must call out user preferences / project conventions"
        );
        assert!(
            p.contains("拍板") || p.contains("决策"),
            "must call out decisions"
        );
        assert!(
            p.contains("记住") || p.contains("以后都这样"),
            "must call out the explicit user-instruction trigger"
        );
    }

    /// 新模板必须含「不触发」反向清单 —— 防止 agent 在闲聊或一次性指令里也乱搜。
    #[test]
    fn template_has_negative_triggers() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("不触发"),
            "must list when NOT to call memory MCP"
        );
        assert!(
            p.contains("闲聊") || p.contains("一次性"),
            "must give concrete don't-trigger examples"
        );
    }

    /// duplicate 返回里有 `candidates` 字段,模板必须教 agent 基于 candidates 做决策。
    #[test]
    fn template_explains_duplicate_candidates_decision() {
        let p = build(&PathBuf::from("/tmp/kode"), "codebuddy");
        assert!(
            p.contains("candidates"),
            "must reference the candidates field"
        );
        assert!(p.contains("force"), "must mention force=true escape hatch");
        assert!(
            p.contains("supersedes"),
            "must mention supersedes path for stale candidate"
        );
        assert!(
            p.contains("词汇撞车"),
            "must explain when candidates are false-positives (different rules sharing vocabulary)"
        );
    }
}
