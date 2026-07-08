---
schema_version: 1
id: specops/document-language-matching
kind: spec
title: SpecOps 文档语言跟随请求语言
status: active
verifies:
  - specops
paths:
  - .codebuddy/skills/specops.intake.md
  - .codebuddy/skills/specops.clarify.md
  - .codebuddy/skills/specops.create-document.md
---

# SpecOps 文档语言匹配请求语言

## 约束

SpecOps 生成的 `proposal.md` / `tasks.md` / `design.md` 正文,以及
`proposal.md` YAML frontmatter 中的 `title` 字段值,必须与触发该次
intake / clarify / create-document 的用户请求正文保持相同的自然语言。

- 中文请求 → 文档正文与 `title` 用中文
- 英文请求 → 文档正文与 `title` 用英文
- 混合语言请求 → 使用请求正文中占主导的语言

YAML frontmatter 的**键名**(`schema_version`、`id`、`kind`、`status`、
`verifies`、`paths`)一律保留英文,因为它们由 SpecOps server / gate /
drift analyzer 解析,翻译会破坏机器可读契约。

`id` 字段使用 ASCII slug(便于文件系统与 URL 引用),不参与语言匹配。

## Motivation

用户提问「你有办法根据提示语言的类型,生成出的 spec 文档也是相同类型的么」
说明该行为并非显式契约,而只是 `specops.intake.md` skill 文件中的一段
说明性文字。把它升级为正式 spec 后:

1. **可发现性**:语言匹配规则进入 `.specops/specs/`,可被 constitution
   引用、被 `specops.analyze` 检查、被新贡献者一次性读到。
2. **稳定性**:skill 文件是工作流实现细节,可被随时改写;spec 是受
   管理的不变量,变更需走 SpecOps 流程。
3. **一致性覆盖**:目前只有 `specops.intake.md` 写了语言策略,
   `specops.clarify.md` 和 `specops.create-document.md` 在生成文档时
   同样需要遵守该规则,但未明文约束。

## Scope

- 适用于 SpecOps 所有写入 `.specops/changes/` 或 `.specops/specs/`
  的人工/agent 生成文档路径。
- 适用于 frontmatter `title` 值与 markdown 正文。
- 不适用于:YAML 键名、`id` slug、代码块内的标识符、文件路径、命令行。

## Acceptance criteria

- [ ] `.specops/specs/specops-document-language-matching.md` 存在且
      `kind: spec`、`status: active`。
- [ ] `specops.intake.md` 的 "Document language policy" 一节引用该 spec
      作为权威来源(后续 change 落实,本 spec 不动 skill 文件)。
- [ ] 后续中文 intake 产出的 `proposal.md` / `tasks.md` / `design.md`
      正文为中文,英文 intake 产出为英文,可在 `specops.analyze` 一致性
      检查中被引用。
- [ ] YAML frontmatter 键名保持英文,不被翻译。

## Out of scope

- 自动语言检测算法的实现(由执行 intake 的 agent 自行判断请求主导语言)。
- 翻译已有历史文档(如 `.specops/changes/archive/` 下的英文文档)。
- 修改 SpecOps server/gate 的代码以强制校验语言(仅作为 agent 行为契约)。
- 决定 `title` 之外的 frontmatter 字段是否本地化 —— 当前结论是不本地化。
