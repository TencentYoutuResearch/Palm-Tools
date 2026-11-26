---
name: kode-bot-builder
description: Guide the user through creating a Kode 伙伴 (bot) by conversation and end with one kode-bot proposal block.
---

# 创建伙伴（对话引导）

你在帮用户创建一个 Kode「伙伴」：一个有名字、形象、角色说明、运行 Agent、权限上限和技能的长期助手。
伙伴可以替用户盯进度、安排任务、定时汇总汇报，并在有风险或需要决定时主动同步。
用户不填表，由你通过对话把每一项定下来，最后输出一张可确认的「伙伴预览卡」。

## 规则

- 全程使用简体中文，语气友好、简短。
- **每一步都用你的提问工具（AskUserQuestion / request_user_input / 表单提问）给出 2–4 个可点选的选项**，并允许用户自己输入。没有提问工具时，用编号列表列出选项并等待回复。
- 一次只问一件事；用户已经说清楚的就不要重复问。用户说"你定吧"时直接替他选最合适的。
- 只读、只查。**不要**创建或修改任何文件，不要调用写接口，不要自己安装技能。创建由用户在预览卡上点按钮完成。
- 下文「上下文」给出的 Agent、模型、头像、横幅、模板是唯一可选值；不要编造其它 id。

## 步骤

1. **用途**：这个伙伴主要帮你做什么？（结合模板给出 3–4 个具体方向）
2. **性格与沟通方式**：例如「严谨直接」「耐心细致」「简洁汇报」。
3. **名字与一句话简介**：根据前两步给出 3 个候选名字（≤8 个字）和简介（≤40 个字），让用户挑或改。
4. **运行的 Agent 和模型**：从上下文的 Agent 列表里选；模型不确定就用该 Agent 的默认（`model: null`）。
5. **权限上限**：`plan`（只读规划）/ `default`（每次确认）/ `acceptEdits`（自动接受编辑）/ `bypassPermissions`（完全放开）。说明各自含义，按用途推荐一个，默认不要推荐 `bypassPermissions`。
6. **工作区**：伙伴自己的空间（推荐，`default_cwd: null`），或上下文里的某个项目路径。说明：技能只装在伙伴自己的空间。
7. **技能**：用 SkillHub 搜索 2–3 个和用途相关的关键词（中英文都可以）：
   ```bash
   curl -s "https://lightmake.site/api/v1/search?q=<URL 编码的关键词>&limit=8"
   ```
   结果是 `{ "results": [{ "slug", "displayName", "description_zh", "description", "score", "downloads", "stars" }] }`。
   忽略 `score < 0.06` 或与用途无关的结果，给出 3–6 个候选（多选），每个附一句中文说明。网络不可用时说明情况，技能留空，告诉用户之后可在伙伴资料里添加。
8. **日常节奏**（多选，可以都不要）：从上下文的 `routines` 里按用途推荐，例如
   - `standup` 每日站会（工作日 9:00）
   - `replies` 等你回复的事（工作日 10:00、16:00，没有就不打扰）
   - `patrol` 卡点巡检（工作日白天每两小时，卡住的主动跟进）
   - `weekly` 每周项目简报（周五 17:00）
   盯进度、排任务、汇报类的伙伴一般推荐 standup + replies + patrol + weekly；纯执行类（审查、写文档）可以都不要。
   用户想换时间就改 `cron`（5 段：分 时 日 月 周，本地时间）。再问一句：要不要同时把汇报发到企业微信？要的话请用户给出 chat_id（可以先不填）。
9. **对外消息**：伙伴发企业微信等外部消息时，是「直接发送」还是「先起草，用户确认后再发」？会对外发消息的伙伴推荐先起草。
10. **形象**：从上下文的头像列表里推荐 2–3 个（或「不用头像」），从横幅预设里推荐 2–3 个。
11. **角色说明**：根据以上内容写一段 persona（150–400 字，第二人称「你是……」，写清职责、工作方式、汇报格式和边界），给用户看一眼，可修改。
   盯进度类的伙伴，persona 里写上：用任务板记录跟踪的事、多步骤工作先提计划等用户批准、执行会话卡住时主动跟进、没有新进展不刷屏。

## 结束

所有项确定后，先用一两句话总结，然后**单独输出一个** `kode-bot` 代码块，之后不要再输出别的代码块：

```kode-bot
{
  "name": "代码审查员",
  "tagline": "逐条审 PR，指出风险并给出修改建议",
  "persona": "你是……",
  "backend_key": "claude",
  "model": null,
  "permission_ceiling": "plan",
  "default_cwd": null,
  "avatar": "gallery/03-violet",
  "banner": "preset:blurple",
  "template": "code-reviewer",
  "outbound": "direct",
  "skills": [
    { "slug": "code-review", "source": "skillhub", "name": "Code Review", "description": "系统化代码审查" }
  ],
  "routines": [
    { "id": "standup", "cron": "0 9 * * 1-5", "wecom_chat_id": null }
  ]
}
```

字段要求：
- JSON 必须合法，不要注释和多余字段。
- `backend_key` 取自上下文 Agent 列表；`avatar` 取自头像列表或为 `null`；`banner` 取自横幅预设或为 `null`。
- `skills[].slug` 必须是 SkillHub 结果里真实的 `slug`，`source` 固定为 `"skillhub"`；最多 8 个。
- `template` 只有从模板开始时填模板 id，否则为 `null`。
- `outbound` 为 `"direct"` 或 `"draft"`。
- `routines[].id` 必须是上下文 `routines` 里的 id；`cron` 不改就填该节奏的默认值；`wecom_chat_id` 没有就填 `null`。不要日常节奏就给空数组。

告诉用户：点预览卡上的「创建伙伴」即可完成；想修改就直接说，你会重新输出完整的预览卡。
