//! 配置文件读取(可选,有默认)。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    #[serde(default = "default_backend_key")]
    pub default_backend: String,
    #[serde(default)]
    pub backends: HashMap<String, BackendConfig>,
    #[serde(default)]
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct BackendConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 启动时使用的模型(也是状态栏初始显示)。
    /// 若 `model_flag` 也设了,kode 自动把 `[model_flag, default_model]` 注入子进程参数。
    #[serde(default)]
    pub default_model: Option<String>,
    /// 后端 CLI 用来选模型的 flag,通常是 "--model"。设了才注入。
    #[serde(default)]
    pub model_flag: Option<String>,
    /// 后端 CLI 用来设置 permission mode 的 flag,通常是 "--permission-mode"。
    /// 仅当 spawn 时显式传入 mode 才注入(`Session::new` 的 `permission_mode` 参数)。
    /// codebuddy / claude code 有效值:acceptEdits / bypassPermissions / default / plan。
    /// 注意:GUI 上层用户视角是 "default" / "bypass" 二选一,inject 时翻译。
    #[serde(default)]
    pub permission_mode_flag: Option<String>,
    /// **2026-06** 声明这个 backend 怎么接 memory MCP。
    /// `None` = backend 不参与 memory MCP 自动接入(纯 PTY 跑 CLI,跟 memory 无关)。
    /// `Some(spec)` = 启动时若 spec 里的 CLI 在 PATH 上但 mcp 还未配,kode 自动跑接入命令。
    /// 三个内置 backend 出厂值都填好(codebuddy → Codebuddy 风格,claude/claude-internal → Claude 风格)。
    /// 用户可以在 `~/.config/kode/config.toml` 覆盖或给新 backend 添加。
    #[serde(default)]
    pub mcp_setup: Option<McpSetupSpec>,
    /// **2026-06** 这个 backend 是否在新建 tab 的 BackendChooser 里展示。
    /// - `None` = 尚未决定:GUI 首次启动会按 PATH 探测 `command`,命中写 `Some(true)`、
    ///   未命中写 `Some(false)`,然后落盘。正常流程首次启动后不再有 `None`。
    /// - `Some(true)` / `Some(false)` = 已生效的开关(首次探测结果 / 用户在 Settings 手改)。
    ///
    /// 判定统一走 [`BackendConfig::is_enabled`](`None` 和 `Some(true)` 都算开)。
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl BackendConfig {
    /// 是否应在 BackendChooser 里展示。`None`(待探测)和 `Some(true)` 都算开,
    /// 只有显式 `Some(false)` 才隐藏。
    pub fn is_enabled(&self) -> bool {
        self.enabled != Some(false)
    }
}

/// MCP 接入策略 —— 描述「怎么把 memory MCP 加进这个 backend」。
///
/// 四种风格覆盖目前已知的 CLI 形态:
/// - `Codebuddy`:commander.js 的 `mcp add`,`-e <env...>` 是 variadic 选项,会**吞**后续
///   所有 token 直到下一个 `-` 开头的 flag。所以参数顺序必须是 positional 在 `-e` 前:
///   `<cli> mcp add -s user <name> <command> [-e KEY=VAL]...`。
///   早期写错(把 `-e` 放 positional 前)会导致 "missing required argument 'name'"。
/// - `Claude`:跟 codebuddy 同源 fork,但 CLI 行为已经分化 —— 不把 `-e` 当 variadic,
///   且**官方文档要求**用 `--` 显式终止 flag 段:
///   `<cli> mcp add -s user <name> [-e KEY=VAL]... -- <command>`。
/// - `Codex`:OpenAI Codex CLI 风格:
///   `<cli> mcp add <name> --env KEY=VAL -- <command>`。
/// - `JsonMerge`:适合那些没有 `mcp add` 子命令的工具 —— kode 直接
///   读 / merge / 写 JSON 配置文件。`config_path` 支持 `~` 展开。
///
/// 序列化形式(TOML):
/// ```toml
/// [backends.mybe.mcp_setup]
/// style = "codebuddy"
/// cli = "mybe"
/// ```
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "style", rename_all = "kebab-case")]
pub enum McpSetupSpec {
    /// `<cli> mcp add -s user <name> <command> [-e KEY=VAL]...`
    Codebuddy { cli: String },
    /// `<cli> mcp add -s user <name> [-e KEY=VAL]... -- <command>`
    Claude { cli: String },
    /// `<cli> mcp add <name> --env KEY=VAL -- <command>`
    Codex { cli: String },
    /// 直写 JSON 配置文件,不调 CLI。
    JsonMerge {
        /// 用户态 mcp 配置文件路径。支持 `~` 前缀展开。
        config_path: String,
    },
}

impl McpSetupSpec {
    /// 该 spec 调用的 CLI 名字(JSON 风格无 CLI,返回 None 让 caller 知道不该 `which`)。
    pub fn cli(&self) -> Option<&str> {
        match self {
            McpSetupSpec::Codebuddy { cli }
            | McpSetupSpec::Claude { cli }
            | McpSetupSpec::Codex { cli } => Some(cli.as_str()),
            McpSetupSpec::JsonMerge { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UiConfig {
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u16,
    #[serde(default = "yes")]
    pub sidebar_default_visible: bool,
    #[serde(default = "default_fps")]
    pub fps_cap: u32,
    #[serde(default = "default_idle_ms")]
    pub idle_threshold_ms: u64,
    /// vt100 滚动缓冲行数(scrollback);0 = 关闭。用户进入 Scroll 模式后才会看到。
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: usize,
}

fn default_backend_key() -> String {
    "codebuddy".into()
}
fn default_sidebar_width() -> u16 {
    24
}
fn yes() -> bool {
    true
}
fn default_fps() -> u32 {
    60
}
fn default_idle_ms() -> u64 {
    200
}
fn default_scrollback_lines() -> usize {
    5000
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            sidebar_width: default_sidebar_width(),
            sidebar_default_visible: yes(),
            fps_cap: default_fps(),
            idle_threshold_ms: default_idle_ms(),
            scrollback_lines: default_scrollback_lines(),
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        let mut backends = HashMap::new();
        backends.insert(
            "codebuddy".into(),
            BackendConfig {
                command: "codebuddy".into(),
                // 不传任何 positional 参数 —— codebuddy 直接跑就是交互模式;
                // 任何 positional 都会被当作初始 prompt 发给 LLM。
                args: vec![],
                // default_model 留空(GUI 新建 tab 时由用户在 BackendChooser 选);
                // model_flag 出厂启用 "--model",这样 spawn 时只要传入 model
                // 就会被 inject_model_flag 拼到子进程命令行上。
                default_model: None,
                model_flag: Some("--model".into()),
                permission_mode_flag: Some("--permission-mode".into()),
                mcp_setup: Some(McpSetupSpec::Codebuddy {
                    cli: "codebuddy".into(),
                }),
                enabled: None,
            },
        );
        backends.insert(
            "claude-internal".into(),
            BackendConfig {
                // 用户内部环境的 claude 入口(自带 wrapper 脚本或别名)
                // 用户的 PATH 里需要有这个命令。如果实际命令名不同,
                // 可在 ~/.config/kode/config.toml 覆盖 command 字段
                command: "claude-internal".into(),
                args: vec![],
                default_model: None,
                model_flag: Some("--model".into()),
                permission_mode_flag: Some("--permission-mode".into()),
                mcp_setup: Some(McpSetupSpec::Claude {
                    cli: "claude-internal".into(),
                }),
                enabled: None,
            },
        );
        backends.insert(
            "claude".into(),
            BackendConfig {
                command: "claude".into(),
                args: vec![],
                default_model: None,
                model_flag: Some("--model".into()),
                permission_mode_flag: Some("--permission-mode".into()),
                mcp_setup: Some(McpSetupSpec::Claude {
                    cli: "claude".into(),
                }),
                enabled: None,
            },
        );
        backends.insert(
            "codex".into(),
            BackendConfig {
                command: "codex".into(),
                args: vec![],
                default_model: None,
                model_flag: Some("--model".into()),
                // Codex CLI 没有 codebuddy/claude 的 --permission-mode;
                // Session 注入层会把 bypass 映射成:
                //   --ask-for-approval never --sandbox danger-full-access
                permission_mode_flag: Some("--ask-for-approval".into()),
                mcp_setup: Some(McpSetupSpec::Codex {
                    cli: "codex".into(),
                }),
                enabled: None,
            },
        );
        // 2026-06:预置一批常见 AI CLI(参考 kooky)。这些大多不是 codebuddy/claude
        // fork,没有兼容的 `mcp add`,所以 mcp_setup 一律 None。command = 二进制名。
        // enabled = None:GUI 首次启动按 PATH 探测落地(只开实际装了的)。
        // model_flag 多数填 "--model"(常见约定;不对的 backend 用户可在 config.toml 改)。
        for (key, command) in [
            ("gemini", "gemini"),
            ("opencode", "opencode"),
            ("amp", "amp"),
            ("cursor", "cursor-agent"),
            ("copilot", "copilot"),
            ("grok", "grok"),
            ("antigravity", "agy"),
            ("kimi", "kimi"),
            ("pi", "pi"),
            ("kiro", "kiro-cli"),
            ("droid", "droid"),
        ] {
            backends.insert(
                key.into(),
                BackendConfig {
                    command: command.into(),
                    args: vec![],
                    default_model: None,
                    model_flag: Some("--model".into()),
                    permission_mode_flag: None,
                    mcp_setup: None,
                    enabled: None,
                },
            );
        }
        Self {
            default_backend: default_backend_key(),
            backends,
            ui: UiConfig::default(),
        }
    }
}

impl Config {
    /// 从默认路径加载,未找到时返回 default。
    pub fn load() -> Self {
        let path = match Self::path() {
            Some(p) => p,
            None => return Self::default(),
        };
        Self::load_from(&path)
    }

    /// 从指定路径加载 config.toml。文件不存在 / 解析失败都降级为默认值。
    /// GUI 端用户在 PathsBanner 里切换 config 路径后调这个版本。
    pub fn load_from(path: &std::path::Path) -> Self {
        let txt = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return Self::default(),
        };
        match toml::from_str::<Config>(&txt) {
            Ok(mut c) => {
                // 合并默认 backends(用户没写也能用)
                let defaults = Self::default();
                for (k, v) in defaults.backends {
                    c.backends.entry(k).or_insert(v);
                }
                c
            }
            Err(e) => {
                tracing::warn!(?path, error = %e, "config parse failed, using defaults");
                Self::default()
            }
        }
    }

    pub fn path() -> Option<PathBuf> {
        Some(dirs::config_dir()?.join("kode").join("config.toml"))
    }

    pub fn backend(&self, key: &str) -> Option<&BackendConfig> {
        self.backends.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归:codebuddy 默认不能带任何 positional 参数,否则会被当作初始 prompt 发给 LLM
    #[test]
    fn default_codebuddy_backend_has_no_positional_args() {
        let cfg = Config::default();
        let b = cfg.backend("codebuddy").expect("codebuddy backend");
        assert!(
            b.args.is_empty(),
            "codebuddy default args must be empty (positional args become a prompt), got: {:?}",
            b.args
        );
    }

    #[test]
    fn default_claude_backend_has_no_positional_args() {
        let cfg = Config::default();
        let b = cfg.backend("claude").expect("claude backend");
        assert!(
            b.args.is_empty(),
            "claude default args must be empty, got: {:?}",
            b.args
        );
    }

    #[test]
    fn default_codex_backend_has_no_positional_args() {
        let cfg = Config::default();
        let b = cfg.backend("codex").expect("codex backend");
        assert!(
            b.args.is_empty(),
            "codex default args must be empty, got: {:?}",
            b.args
        );
    }

    /// 回归:三个内置 backend 都要有 permission_mode_flag(默认 --permission-mode)。
    /// GUI 启动 BackendChooser 选 bypass 时,后端按这个 flag 注入子进程。
    #[test]
    fn default_backends_have_permission_mode_flag() {
        let cfg = Config::default();
        for key in ["codebuddy", "claude", "claude-internal"] {
            let b = cfg.backend(key).expect(key);
            assert_eq!(
                b.permission_mode_flag.as_deref(),
                Some("--permission-mode"),
                "{key} should default to --permission-mode flag"
            );
        }
        let codex = cfg.backend("codex").expect("codex");
        assert_eq!(
            codex.permission_mode_flag.as_deref(),
            Some("--ask-for-approval")
        );
    }

    /// 回归:三个内置 backend 都要有 model_flag(默认 --model)。
    /// GUI 新建 tab 时由用户在 BackendChooser 里选 model,后端按这个 flag 注入子进程;
    /// restore 时把上次保存的 model 通过 spawn_session 透传同样走这个 flag。
    /// default_model 留空 → 用户没指定时不注入,行为与旧版一致(状态栏显示 "auto",
    /// jsonl_tail 同步到真实模型名)。
    #[test]
    fn default_backends_have_model_flag() {
        let cfg = Config::default();
        for key in ["codebuddy", "claude", "claude-internal", "codex"] {
            let b = cfg.backend(key).expect(key);
            assert_eq!(
                b.model_flag.as_deref(),
                Some("--model"),
                "{key} should default to --model flag"
            );
            assert!(
                b.default_model.is_none(),
                "{key} default_model should be None (model is chosen per-tab)"
            );
        }
    }

    /// 回归:内置 backend 都要有 mcp_setup,且风格匹配真实 CLI 行为。
    /// codebuddy 用 commander.js 风格(positional 先于 -e),claude/claude-internal
    /// 都得用 `--` 终止 flag 段(claude family CLI 不再把 -e 当 variadic)。
    /// 早期 memory_mcp.rs 把这个映射写死,现在挪到 config 数据,新增 backend 也能填。
    #[test]
    fn default_backends_have_mcp_setup_with_correct_style() {
        let cfg = Config::default();
        let cb = cfg.backend("codebuddy").expect("codebuddy");
        match &cb.mcp_setup {
            Some(McpSetupSpec::Codebuddy { cli }) => assert_eq!(cli, "codebuddy"),
            other => panic!("codebuddy should use Codebuddy mcp_setup, got {:?}", other),
        }
        for key in ["claude", "claude-internal"] {
            let b = cfg.backend(key).expect(key);
            match &b.mcp_setup {
                Some(McpSetupSpec::Claude { cli }) => assert_eq!(cli, key),
                other => panic!("{key} should use Claude mcp_setup, got {:?}", other),
            }
        }
        let codex = cfg.backend("codex").expect("codex");
        match &codex.mcp_setup {
            Some(McpSetupSpec::Codex { cli }) => assert_eq!(cli, "codex"),
            other => panic!("codex should use Codex mcp_setup, got {:?}", other),
        }
    }

    /// 回归:2026-06 预置的一批常见 AI CLI 都在默认列表里,且出厂 enabled == None
    /// (留给 GUI 首次启动按 PATH 探测落地)。command 必须是预期的二进制名。
    #[test]
    fn default_backends_include_preset_agents() {
        let cfg = Config::default();
        let expected = [
            ("gemini", "gemini"),
            ("opencode", "opencode"),
            ("amp", "amp"),
            ("cursor", "cursor-agent"),
            ("copilot", "copilot"),
            ("grok", "grok"),
            ("antigravity", "agy"),
            ("kimi", "kimi"),
            ("pi", "pi"),
            ("kiro", "kiro-cli"),
            ("droid", "droid"),
        ];
        for (key, command) in expected {
            let b = cfg
                .backend(key)
                .unwrap_or_else(|| panic!("missing backend {key}"));
            assert_eq!(b.command, command, "{key} command");
            assert_eq!(b.enabled, None, "{key} should ship with enabled=None");
            assert!(b.mcp_setup.is_none(), "{key} should have no mcp_setup");
        }
        // 4 内置 + 11 预置 = 15。
        assert!(
            cfg.backends.len() >= 15,
            "expected >=15 backends, got {}",
            cfg.backends.len()
        );
    }

    /// 回归:`is_enabled()` 把 None / Some(true) 都当开,只有 Some(false) 隐藏。
    #[test]
    fn backend_is_enabled_semantics() {
        let mut b = Config::default().backend("codebuddy").unwrap().clone();
        b.enabled = None;
        assert!(b.is_enabled(), "None should be enabled (pending detect)");
        b.enabled = Some(true);
        assert!(b.is_enabled());
        b.enabled = Some(false);
        assert!(!b.is_enabled(), "Some(false) should be hidden");
    }

    /// 回归:`McpSetupSpec::cli()` helper 在 JsonMerge 风格下返回 None
    /// (告诉调用方「这种 spec 不靠 CLI 写,所以别 `which` 也别检查 PATH」)。
    #[test]
    fn mcp_setup_spec_cli_helper_is_none_for_json_merge() {
        let spec = McpSetupSpec::JsonMerge {
            config_path: "~/.fake/mcp.json".into(),
        };
        assert_eq!(spec.cli(), None);
        let cb = McpSetupSpec::Codebuddy { cli: "x".into() };
        assert_eq!(cb.cli(), Some("x"));
        let c = McpSetupSpec::Claude { cli: "y".into() };
        assert_eq!(c.cli(), Some("y"));
        let codex = McpSetupSpec::Codex {
            cli: "codex".into(),
        };
        assert_eq!(codex.cli(), Some("codex"));
    }

    /// 回归:`mcp_setup` 字段在 TOML 里是嵌套表,必须能正常 deserialize。
    /// 用户在 config.toml 里写 `[backends.foo.mcp_setup] style = "codebuddy" cli = "foo"`
    /// 时不能炸。同时验证未填 mcp_setup 字段时 deserialize 为 None(向后兼容老配置)。
    #[test]
    fn backend_with_mcp_setup_deserializes_from_toml() {
        let txt = r#"
default_backend = "myb"
[backends.myb]
command = "myb"
[backends.myb.mcp_setup]
style = "codebuddy"
cli = "myb"

[backends.legacy]
command = "legacy"
"#;
        let c: Config = toml::from_str(txt).expect("parse");
        let myb = c.backend("myb").expect("myb");
        match &myb.mcp_setup {
            Some(McpSetupSpec::Codebuddy { cli }) => assert_eq!(cli, "myb"),
            other => panic!("expected Codebuddy spec, got {:?}", other),
        }
        // 老 backend 不写 mcp_setup → None,跟以前一样能跑(但不参与自动接入)
        let legacy = c.backend("legacy").expect("legacy");
        assert!(
            legacy.mcp_setup.is_none(),
            "missing field should default to None"
        );
    }
}
