---
schema_version: 1
id: memory/quickstart
kind: spec
title: kode-memory quickstart — 5-minute hands-on guide
status: active
verifies:
  - rust
paths:
  - crates/kode-memory/src/bin/cli.rs
  - crates/kode-memory/src/bin/mcp_server.rs
---

# kode-memory 快速上手

> 5 分钟从零体验。不用 GUI,纯 CLI + 任意 MCP-兼容 agent(Claude Code / codebuddy / Cline...)。

## 1. 装

```bash
cd /Users/marxwang/Projects/youtu/app/nocode
cargo build --release -p kode-memory
# 出两个二进制:
#   target/release/kode-memory       CLI(给人 / 脚本用)
#   target/release/kode-memory-mcp   MCP server(给 LLM 用)

# 可选:加 PATH
export PATH="$PWD/target/release:$PATH"
```

## 2. 初始化(带 50+ 种子 fact 的"满血"环境)

```bash
kode-memory init --with-baseline
```

会在 `~/.kode-memory/` 下建好目录,把项目里 51 条种子 fact(从 `CODEBUDDY.md` / `ROADMAP.md` 抽出来的)落入 `facts/`,**直接可搜**。

## 3. 体验剧本(2 分钟)

```bash
# 看总览
kode-memory dashboard

# 试搜索
kode-memory search "PTY 死锁"
kode-memory search "GUI 字节流" --top-k 3
kode-memory search "FTS5 中文" --scope shared

# 提一条新 fact(进 pending)
kode-memory propose "Tauri 2 的 emit 比 Channel 慢 10 倍" \
    --author user --scope project:kode \
    --tags tauri,perf --rationale "刚才看 ROADMAP 看到的"

# 看待审队列
kode-memory pending

# 用上一步打印的 id 审核
kode-memory review <id> --verdict approve
# 或:
kode-memory review <id> --verdict reject  --reason "重复"
kode-memory review <id> --verdict edit_then_approve --edited-body "更精准的表述"

# 看能量
kode-memory budget
kode-memory budget user
```

试试**完全重复检测**:再 propose 同一条文本,会直接被拦,提示 supersedes。

## 4. 接到 Claude Code(让 LLM 用上 memory)

把这段加到 `~/.claude.json` 的 `mcpServers`(没有就新建):

```json
{
  "mcpServers": {
    "kode-memory": {
      "command": "/Users/marxwang/Projects/youtu/app/nocode/target/release/kode-memory-mcp",
      "env": {
        "KODE_MEMORY_ROOT": "/Users/marxwang/.kode-memory"
      }
    }
  }
}
```

重启 Claude Code,然后试:

> "用 memory_search 搜一下 PTY 相关的项目知识"
> "把这条踩坑写到 memory:Tauri 的 IPC channel 比 emit 快 10 倍。author 写 claude。"

LLM 会调 `memory_search` / `memory_propose`,后者会**进 pending**(默认不让 LLM 直接污染池子)。你随时用 `kode-memory pending` 看 LLM 提议了啥,审核掉。

### 4.1 给 codebuddy 接(同理)

codebuddy 也支持 MCP,配置文件位置和 schema 一样:`~/.codebuddy/config.json`,`mcpServers` 字段。

### 4.2 验证 MCP 起来了

直接喂 JSON-RPC 试:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    | KODE_MEMORY_ROOT=~/.kode-memory \
      ./target/release/kode-memory-mcp \
    | python3 -m json.tool
```

应能看到 8 个 tool spec(memory_search / memory_read / memory_propose / ...)。

## 5. CLI 命令速查

```
kode-memory init [--with-baseline]
                            初始化目录,可选灌种子
kode-memory propose <body>  --author X --scope X --tags a,b --rationale ...
                            提议(扣 1 能量,进 pending)
kode-memory pending [--limit N]
                            列待审
kode-memory review <id> --verdict approve|reject|blacklist|edit_then_approve
                            审核;edit_then_approve 可同时改 body/scope/tags/confidence
kode-memory search <q> [--scope X --top-k N]
                            FTS5 + bm25 + confidence 加权检索
kode-memory read <id>       看完整 fact
kode-memory recent [--hours N]
                            最近 N 小时新增
kode-memory deprecate <id> --reason ...
                            软删
kode-memory budget [author] 看能量(全部 / 某 author)
kode-memory dashboard       总览(facts/pending/rejected/能量条)
```

环境变量:
- `KODE_MEMORY_ROOT`:数据根(默认 `~/.kode-memory`)
- `NO_COLOR=1`:关 ANSI 上色

## 6. 文件存哪 / 长什么样

```
~/.kode-memory/
├── facts/<id>.md             已审核,被检索  ← source of truth(可 git push)
├── pending/<id>.md           待审提议
├── archive/rejected/<id>.md  被拒(30 天后清理)
├── budget.json               能量账本
├── tmp/                      原子写暂存(应空)
└── index.sqlite              FTS5 索引(可重建,删了再 init 不会丢数据)
```

每条 fact 是个普通 markdown 文件:

```markdown
---
id: 01HXYZ7K...
author: codebuddy
scope: project:kode
created: 2026-06-02T10:00:00Z
confidence: 0.9
tags: [pty, deadlock]
---
PtyHost::kill 必须用 clone_killer() 拿独立 kill 句柄。
原因:reaper 和 killer 同时持 Mutex<Child> 会死锁。
```

> 用 vim 直接改 `facts/<id>.md` 也行 —— 下次 `kode-memory dashboard` 会跑 reconcile 自动同步索引。
> 要跨机同步?把 `facts/` 推 git 就行,SQLite 不需要同步。

## 7. 心智模型小抄

**memory 是什么** —— 项目级 gotcha + 经验沉淀池。给"无处可写但需要被记住"的元知识用。
**memory 不是什么** —— 用户偏好库 / 会话历史 / 知识库 / TODO。

**写入门槛**:agent 不能直接写,必须 `memory_propose` → 进 pending → 用户 `review` 后才进检索池。能量预算防泛滥。

**好的 fact 长什么样**(从 baseline 抽几条):
- "PtyHost::kill 必须用 clone_killer() 拿独立 kill 句柄。原因:reaper 和 killer 同时持 Mutex<Child> 会死锁。"
- "FTS5 默认 unicode61 不分词中文。改 tokenize='trigram'。"
- "Tauri GUI 字节流必须用 Channel<Vec<u8>>,emit 走 JSON 高频时延迟高。"

特征:**短(≤500 字)、有原因、可被未来的我或别的 agent 直接行动。**

**不该写的**(参考拒收清单):
- "用户喜欢蓝色主题"(用户偏好,不归 memory 管)
- "Rust async 怎么用"(知识/文档,不是元知识)
- "我现在在改 reader.rs"(会话状态)
- "我觉得这个不错"(opinion 没原因)

## 8. 验收 checklist(自检你 5 分钟跑完了)

- [ ] `kode-memory dashboard` 显示 facts=51 / pending=0
- [ ] `kode-memory search "PTY"` 至少 3 条命中,score 在 0.5~0.85 之间
- [ ] propose 完全相同的文本 → 提示 `duplicate similarity=1.00`
- [ ] propose 新 fact → energy 从 5.00 → 4.00
- [ ] approve → facts++ 且 energy → 4.50
- [ ] reject → archive/rejected/ 多一条文件,energy → 3.00
- [ ] Claude Code 调 memory_search 能拿到结果

## 9. 然后呢

- 当前 baseline:**Top-5 73.3% / Top-1 60.0%**(31 个测试全绿)
- 下一步增强方向:
  - **embedding 重排**:加 fastembed-rs,baseline 应能上 90%+(M5 之后做)
  - **GUI 集成**(M4):kode 主程序加 `Cmd+Shift+M` 待审队列 + 状态栏徽章
  - **指标仪表盘**(M5):metrics.jsonl + 7/30 天接受率 / 跨 agent 质量对比

详见 [`.specops/specs/memory-design.md`](./memory-design.md) 和 [`ROADMAP.md`](./roadmap.md) Phase 10。
