---
schema_version: 1
id: 355425ba-d70b-484e-a254-d290fa4433ca
kind: investigation
title: PTY 显示乱码根因分析与防御
status: proposed
verifies:
  - rust
paths:
  - crates/kode-core/src/session/mod.rs
  - crates/kode-core/src/pty/mod.rs
  - apps/gui/src-tauri/src/state.rs
  - apps/gui/src-tauri/src/commands.rs
---

# PTY 显示乱码根因分析与防御

用户请求:

> 你分析下当前pty显示的方式，为啥还是有概率出现乱码，如何避免或者出现后不要影响后续的

## Motivation

PTY 终端显示存在概率性乱码，表现为:
1. 非 ASCII 字符（中文、emoji）偶尔显示为替换字符或乱码
2. 部分 ANSI 样式/颜色错乱
3. 问题具有随机性（取决于 PTY 读写时序），难以稳定复现

当前已有 locale 兜底修复（`pty/mod.rs:83-94`，注入 `LANG=en_US.UTF-8`），但用户仍遇到乱码，说明存在其他根因。

## Scope

1. 分析 PTY 字节流从读取到渲染的完整链路，识别所有可能导致乱码的环节
2. 设计轻量级防御方案：UTF-8 序列跨 chunk 拼接 + 边界保护
3. 在 Session::feed 层添加 UTF-8 缓冲，消除最高概率的乱码根因
4. 在 GUI coalesce 层添加 UTF-8 完整性检查（防御纵深）
5. 加固 screen_snapshot 的 UTF-8 处理
6. 添加回归测试覆盖截断场景

## Acceptance criteria

1. `Session::feed()` 能正确处理 UTF-8 序列跨 chunk 截断（2/3/4 字节序列各覆盖）
2. GUI coalesce 循环不会向 xterm.js 发送不完整的 UTF-8 序列
3. `get_screen_snapshot` 返回的字符串始终是合法 UTF-8
4. 单元测试覆盖各种截断场景
5. 集成测试：快速连续输出中文/emoji 后屏幕不含 `\u{FFFD}` 替换字符
6. 现有 24+ 测试全部通过，无性能回归

## Out of scope

- 替换 vt100-ctt 为其他终端模拟器
- 修改 vt100-ctt 上游代码
- 完整的 ANSI 序列跨 chunk 保护（概率极低）
- 修改 PTY reader 线程
- CJK 宽字符 wrap 修复（vt100-ctt 设计限制）
