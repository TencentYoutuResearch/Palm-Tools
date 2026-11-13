//! 全 backend 统一生命周期测试矩阵 —— kode-core 纯逻辑层。
//!
//! 单一数据源是 [`Config::default`] 的 17 个 backend。`Case` / 能力位全部从
//! `BackendConfig`、`BackendProfile`、`Backend::from_backend_key` 派生，不写
//! `if key == "codebuddy"` 之类的分支(CODEBUDDY.md 硬约束)。
//!
//! 上层 crate(kode-bridge / gui / 前端)各有一份同构矩阵：语义解析在
//! kode-bridge、`uses_structured_transport` 与安装配方在 gui，跨 crate 可见性
//! 决定无法单文件覆盖六环节。各层靠 `BACKEND_KEYS` golden 与
//! `cases().len() == 17` 保持一致 —— 新增 backend 忘记登记会立刻失败。
//!
//! 能力不齐(仅 codebuddy / opencode 声明 acp、opencode / kimi 无 transcript 语义解析、
//! 10 个 preset 既无 mcp_setup 也无 acp,其中只有 kimi 接了 metadata tail)由 [`tier`] 分派 `Assert` /
//! `Placeholder`，占位只登记原因、不写空测试假装覆盖。

use std::collections::{BTreeMap, BTreeSet};

use crate::config::{AcpSpec, BackendConfig, Config};
use crate::session::backend::{profile_for_key, ResumeStyle};
use crate::session::jsonl_tail::Backend;

/// 与 `Config::default()` 的 key 集一一对应的 golden 清单(17 项,字典序)。
/// 这是矩阵里唯一允许手写的 backend 清单,作用是「新增 backend 自动暴露遗漏」。
const BACKEND_KEYS: &[&str] = &[
    "amp",
    "antigravity",
    "claude",
    "claude-internal",
    "codebuddy",
    "codex",
    "copilot",
    "cursor",
    "droid",
    "gemini",
    "grok",
    "kimi",
    "kiro",
    "opencode",
    "pi",
    "tclaude",
    "tcodex",
];

/// 生命周期六环节,与「开启 / 更新 / 通信 / acp / 菜单选择 / 恢复」一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Enable,
    Update,
    Communicate,
    Acp,
    Menu,
    Restore,
}

impl Stage {
    const ALL: [Stage; 6] = [
        Stage::Enable,
        Stage::Update,
        Stage::Communicate,
        Stage::Acp,
        Stage::Menu,
        Stage::Restore,
    ];

    fn name(self) -> &'static str {
        match self {
            Stage::Enable => "enable",
            Stage::Update => "update",
            Stage::Communicate => "communicate",
            Stage::Acp => "acp",
            Stage::Menu => "menu",
            Stage::Restore => "restore",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tier {
    Assert,
    /// 该 backend 在此环节缺能力/依赖,本轮只登记原因不断言。
    Placeholder,
}

/// 占位原因登记(按环节)。`every_backend_stage_cell_is_classified` 会校验每个
/// Placeholder 都有对应原因,避免静默漏测。
const PLACEHOLDER_REASONS: &[(&str, &str)] = &[
    (
        "acp",
        "仅 codebuddy / opencode 声明 acp,其余 backend 只走 PTY",
    ),
    (
        "communicate",
        "opencode 无 transcript 解析(结构化事件走 ACP);kimi 只接 metadata;其余 9 个 preset 无 tail",
    ),
    (
        "menu",
        "真实 BackendChooser / 安装确认交互需 GUI E2E,本轮只做静态断言",
    ),
    (
        "enable",
        "backend_set_enabled / resolve_pending_enabled 写盘需 Tauri/toml mock",
    ),
    (
        "update",
        "backend_save 保注释写盘已有专门回归,矩阵只断言默认配置 roundtrip",
    ),
    (
        "restore",
        "真 GUI 重启恢复需端到端,矩阵只覆盖参数注入/语义绑定/字节追平",
    ),
];

#[derive(Debug, Clone)]
struct Case {
    key: String,
    cfg: BackendConfig,
    has_acp: bool,
    has_mcp: bool,
    has_semantic: bool,
    resume_style: ResumeStyle,
}

/// 遍历 `Config::default()` 派生全部用例,排序保证输出稳定。
fn cases() -> Vec<Case> {
    let mut out: Vec<Case> = Config::default()
        .backends
        .iter()
        .map(|(key, b)| Case {
            key: key.clone(),
            has_acp: b.acp.is_some(),
            has_mcp: b.mcp_setup.is_some(),
            has_semantic: Backend::from_backend_key(key)
                .map_or(false, |kind| !matches!(kind, Backend::Opencode | Backend::Kimi)),
            resume_style: profile_for_key(key)
                .map(|p| p.resume_style())
                .unwrap_or(ResumeStyle::Flag),
            cfg: b.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// 由能力位决定某 (backend, 环节) 单元格本轮是断言还是占位。
fn tier(case: &Case, stage: Stage) -> Tier {
    match stage {
        Stage::Acp if !case.has_acp => Tier::Placeholder,
        Stage::Communicate if !case.has_semantic => Tier::Placeholder,
        _ => Tier::Assert,
    }
}

/// resume 形式的 golden 分组：Codex 系用子命令、opencode / kimi 用 `--session`,
/// 其余(含 9 个 preset 与 claude/cursor 系)统一 `--resume`。
const EXPECTED_RESUME: &[(&str, ResumeStyle)] = &[
    ("codex", ResumeStyle::Subcommand),
    ("tcodex", ResumeStyle::Subcommand),
    ("opencode", ResumeStyle::SessionFlag),
    ("kimi", ResumeStyle::SessionFlag),
];

fn expected_resume(key: &str) -> ResumeStyle {
    EXPECTED_RESUME
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, style)| *style)
        .unwrap_or(ResumeStyle::Flag)
}

#[test]
fn golden_backend_keys_match_config() {
    let cases = cases();
    let cfg = Config::default();
    let golden: BTreeSet<&str> = BACKEND_KEYS.iter().copied().collect();
    let actual: BTreeSet<&str> = cases.iter().map(|c| c.key.as_str()).collect();
    let config: BTreeSet<&str> = cfg.backends.keys().map(String::as_str).collect();

    assert_eq!(golden.len(), 17, "BACKEND_KEYS has a duplicate or wrong size");
    assert_eq!(
        actual, config,
        "matrix must cover exactly Config::default() backends"
    );
    assert_eq!(
        actual, golden,
        "update BACKEND_KEYS when adding/removing a built-in backend"
    );
    assert_eq!(actual.len(), 17);
}

/// 开启：`is_enabled()` 三态语义 + 出厂默认可见,逐 backend 覆盖。
#[test]
fn enable_semantics_all() {
    for c in cases() {
        if tier(&c, Stage::Enable) == Tier::Placeholder {
            continue;
        }
        assert!(c.cfg.is_enabled(), "{} should be visible by default", c.key);
        let mut b = c.cfg.clone();
        b.enabled = None;
        assert!(b.is_enabled(), "{}: None means pending detect", c.key);
        b.enabled = Some(true);
        assert!(b.is_enabled(), "{}: Some(true) is on", c.key);
        b.enabled = Some(false);
        assert!(!b.is_enabled(), "{}: Some(false) is hidden", c.key);
    }
}

/// 更新/启动参数：所有默认 args 必须为空,positional 会被 CLI 当成初始 prompt。
#[test]
fn default_args_no_positional_all() {
    for c in cases() {
        assert!(
            c.cfg.args.is_empty(),
            "{} must not inject startup args (positional becomes a prompt): {:?}",
            c.key,
            c.cfg.args,
        );
    }
}

/// 更新：`Config::default()` 序列化成 toml 再 `load_from` 回来,17 个 backend
/// 的 key / command / args / 能力位都不丢(不比较 permission_mode_flag,
/// `load_from` 会做 hydrate 迁移)。
#[test]
fn config_roundtrip_all() {
    let original = Config::default();
    let text = toml::to_string(&original).expect("serialize default config");
    let path = std::env::temp_dir().join(format!(
        "kode-backend-matrix-{}.toml",
        std::process::id()
    ));
    std::fs::write(&path, &text).expect("write temp config");
    let loaded = Config::load_from(&path);
    let _ = std::fs::remove_file(&path);

    let original_keys: BTreeSet<String> = original.backends.keys().cloned().collect();
    let loaded_keys: BTreeSet<String> = loaded.backends.keys().cloned().collect();
    assert_eq!(loaded_keys, original_keys, "roundtrip must preserve all keys");
    assert_eq!(loaded_keys.len(), 17);
    for key in &original_keys {
        let a = &original.backends[key];
        let b = &loaded.backends[key];
        assert_eq!(a.command, b.command, "{key} command");
        assert_eq!(a.args, b.args, "{key} args");
        assert_eq!(a.acp.is_some(), b.acp.is_some(), "{key} acp capability");
        assert_eq!(
            a.mcp_setup.is_some(),
            b.mcp_setup.is_some(),
            "{key} mcp capability"
        );
    }
}

/// 恢复(参数层)：逐 backend 锁定 resume 形式,防止 profile 变更静默改变 argv。
#[test]
fn resume_style_all() {
    for c in cases() {
        assert_eq!(
            c.resume_style,
            expected_resume(&c.key),
            "{} resume style changed; update EXPECTED_RESUME intentionally",
            c.key,
        );
    }
}

/// ACP 能力：仅 codebuddy / opencode 支持,且两者启动方式不同。
#[test]
fn acp_capability_all() {
    let cases = cases();
    let with_acp: BTreeSet<&str> = cases
        .iter()
        .filter(|c| c.has_acp)
        .map(|c| c.key.as_str())
        .collect();
    let expected: BTreeSet<&str> = ["codebuddy", "opencode"].into_iter().collect();
    assert_eq!(with_acp, expected);

    let codebuddy = cases.iter().find(|c| c.key == "codebuddy").unwrap();
    assert_eq!(codebuddy.cfg.acp.as_ref(), Some(&AcpSpec::flag()));
    let opencode = cases.iter().find(|c| c.key == "opencode").unwrap();
    let spec = opencode.cfg.acp.as_ref().expect("opencode acp");
    assert_eq!(spec.args, vec!["acp"]);
    assert!(spec.model_flag.is_none());
}

/// 能力分组与 golden 一致：有 jsonl 语义解析的是 7 个 backend(opencode 走 ACP、
/// kimi 只接 metadata、其余 preset 无 tail);mcp_setup 只有其中 5 个 —— tclaude / tcodex 是
/// opt-in,出厂 `mcp_setup = None`(见 config.rs 的 t-backends 回归)。
#[test]
fn capability_groups_match_golden() {
    let cases = cases();
    let semantic: BTreeSet<&str> = cases
        .iter()
        .filter(|c| c.has_semantic)
        .map(|c| c.key.as_str())
        .collect();
    let mcp: BTreeSet<&str> = cases
        .iter()
        .filter(|c| c.has_mcp)
        .map(|c| c.key.as_str())
        .collect();
    let expected_semantic: BTreeSet<&str> = [
        "claude",
        "claude-internal",
        "codebuddy",
        "codex",
        "cursor",
        "tclaude",
        "tcodex",
    ]
    .into_iter()
    .collect();
    let expected_mcp: BTreeSet<&str> = [
        "claude",
        "claude-internal",
        "codebuddy",
        "codex",
        "cursor",
    ]
    .into_iter()
    .collect();
    assert_eq!(semantic, expected_semantic);
    assert_eq!(mcp, expected_mcp);
    assert!(mcp.is_subset(&semantic));
    assert_eq!(cases.len() - semantic.len(), 10, "10 presets have no semantic parser");
}

/// 骨架自检：17 × 6 个单元格全部被分类,且每个 Placeholder 都有登记的原因。
#[test]
fn every_backend_stage_cell_is_classified() {
    let reasons: BTreeMap<&str, &str> = PLACEHOLDER_REASONS.iter().copied().collect();
    let mut seen_placeholders = BTreeSet::new();
    for c in cases() {
        for stage in Stage::ALL {
            if tier(&c, stage) == Tier::Placeholder {
                seen_placeholders.insert(stage.name());
                assert!(
                    reasons.contains_key(stage.name()),
                    "placeholder for stage {} needs a PLACEHOLDER_REASONS entry",
                    stage.name(),
                );
            }
        }
    }
    assert!(seen_placeholders.contains("acp"));
    assert!(seen_placeholders.contains("communicate"));
}
