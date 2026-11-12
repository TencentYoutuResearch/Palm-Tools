---
schema_version: 2
id: fix-mobile-tcodex-reply-sync
kind: bug
document_class: work_item
work_type: bug
title: mobile TCodex 回复上行链路诊断与修复设计
status: proposed
verifies:
  - rust
paths:
  - apps/mobile/lib/src
  - apps/mobile/test
  - crates/kode-bridge/src
  - crates/kode-core/src/session
  - crates/kode-sync-server/src
---

# mobile TCodex 回复上行链路诊断与修复设计

先按四层证据定位，禁止直接以客户端补丁替代根因：

```text
TCodex JSONL
  -> bridge semantic message events
  -> sync-server events/history + WS
  -> mobile history/WS reducer
```

诊断字段固定为 `worker_id`、`cloud_session_id`、`local_session_id`、
`backend_key=tcodex`、`session_uuid`、Windows transcript absolute path 和
turn timestamp。

## Likely fault boundaries

1. TCodex 实际写的 transcript root 与 Kode `~/.tcodex/sessions` 预期不一致。
2. session UUID binding 或 Windows path normalization 让 semantic tail 没启动、
   tail 了空文件或 tail 到错误文件。
3. semantic parser 发出 `message`，但 cloud sync 因 snapshot 缺 session 或
   event key 冲突未上传。
4. server 已持久化而 mobile reducer 因 cloud id、role 或 optimistic semantic id
   不匹配未合并。

## Confirmed root boundary

当前 Windows 构建中的 `kode-bridge::HookRelay` 和 `kode-memory` hook writer 都是
空实现。Codex/TCodex hook 进程虽然能执行，但无法把 `SessionStart` 写回 GUI
relay，所以：

```text
tcodex SessionStart
  -> KODE_HOOK_SOCK unavailable on Windows
  -> no session.session_uuid_mapped
  -> snapshot session_uuid = null
  -> semantic tail not spawned
  -> no message events uploaded
```

Windows 修复必须在 hook transport 层恢复该链路。使用每实例唯一、仅当前用户可访问
的 Windows named pipe 作为 `KODE_HOOK_SOCK`，并让 `kode-memory codex-hook`
在 Windows 上写入该 pipe。macOS/Linux 继续使用现有 UDS，不改 relay payload。

验证必须证明 hook 写入在 PTY 子进程生命周期内完成，relay 断开时 hook 静默
no-op，且不同 Kode 实例不会串 tab。

## Required probes

- Worker 端 debug log 记录 tail 的 canonical path 和 bound session UUID，不记录
  内容正文或凭据。
- test harness 使用 Windows-style cwd 和 TCodex rollout，断言 user + assistant
  两条 `message` 事件。
- server integration 测试断言 event 写入、history 返回和 WS fanout。
- mobile unit/widget 测试覆盖 canonical user message 替换 optimistic item，
  assistant message 插入且 reconnect history 不重复。

## Repair rule

根因层修复后，其它层只增加防御性测试。例如 hook transport 缺失就恢复 pipe；
transcript path 错就修 path binding；server event key 冲突就修 event identity；
reducer 漏合并才改 mobile。不得同时重写三层协议。
