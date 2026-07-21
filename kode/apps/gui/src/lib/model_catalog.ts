/**
 * model_catalog.ts —— 三个 backend 各自的预设 model 候选清单。
 *
 * 仅前端维护(Rust 不感知),BackendChooser 在用户选 backend 后展示对应清单的下拉,
 * 用户可:
 *   - 从清单选一个 → spawn 时透传给 `--model <value>` 注入子进程
 *   - 留空 / 选"Use backend default" → 不传 model,后端走 backend.default_model 老语义
 *   - 自由输入清单外的 model 名 → 同样透传(给 advanced 用户与新模型上线留口子)
 *
 * 设计要点:
 *   - `value` 是真正传给子进程 `--model` 的字符串。**必须**与 codebuddy / claude
 *     CLI 文档里给的 model 名严格一致,否则子进程会拒绝或回退默认。
 *   - `label` 仅 UI 显示;`shortModelName(value)` 不一定等于 `label`,UI 可以更友好。
 *   - 老 schema:codebuddy 用 `<tier>-<ver>` 顺序;claude code 用 `<ver>-<tier>`。
 *     这里**严格按各自子进程实际接受的写法**,不要试图统一;model_alias.ts::shortModelName
 *     已经把两种写法压成相同短名供展示。
 */

export interface ModelOption {
  /** 真正传给 `--model` 的字符串 */
  value: string
  /** UI 显示的人类可读名 */
  label: string
}

/**
 * 三个 backend 的预设清单。**首版按"jsonl 里出现过 / 子进程 README 里列出"的型号写**;
 * 任何时候发现型号不被子进程接受应当从清单里移除而不是改 value。
 *
 * 维护建议:用户实测某后端跑某 model 成功后,把名字加进来即可。
 */
export const BACKEND_MODELS: Record<string, ModelOption[]> = {
  codebuddy: [
    // codebuddy 用的是 anthropic 通过腾讯网关,model 名沿用 claude- 前缀
    { value: 'claude-opus-4.7-1m', label: 'Opus 4.7 (1M)' },
    { value: 'claude-opus-4.7', label: 'Opus 4.7' },
    { value: 'claude-sonnet-4.6-1m', label: 'Sonnet 4.6 (1M)' },
    { value: 'claude-sonnet-4.6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4.6', label: 'Haiku 4.6' },
  ],
  claude: [
    // 官方 Anthropic Claude Code,model 名是 ver 在前 tier 在后
    { value: 'claude-4.7-opus', label: 'Opus 4.7' },
    { value: 'claude-4.6-sonnet', label: 'Sonnet 4.6' },
    { value: 'claude-4.6-haiku', label: 'Haiku 4.6' },
    // 也可以写 alias:opus / sonnet / haiku
    { value: 'opus', label: 'Opus (alias)' },
    { value: 'sonnet', label: 'Sonnet (alias)' },
    { value: 'haiku', label: 'Haiku (alias)' },
  ],
  'claude-internal': [
    // 与 claude 同一 CLI,同一组 model 名
    { value: 'claude-4.7-opus', label: 'Opus 4.7' },
    { value: 'claude-4.6-sonnet', label: 'Sonnet 4.6' },
    { value: 'claude-4.6-haiku', label: 'Haiku 4.6' },
    { value: 'opus', label: 'Opus (alias)' },
    { value: 'sonnet', label: 'Sonnet (alias)' },
    { value: 'haiku', label: 'Haiku (alias)' },
  ],
}

/**
 * 拿到某 backend 的模型选项;未识别 backend 返回空数组(UI 退化为只有自由输入)。
 */
export function modelsFor(backendKey: string): ModelOption[] {
  return BACKEND_MODELS[backendKey] ?? []
}
