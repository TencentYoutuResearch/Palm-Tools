---
schema_version: 2
id: add-terminal-path-segment-navigation
document_class: design
status: proposed
---

# Design

## Path link model

终端路径解析不直接调用操作系统。一个纯函数把原始匹配转换为累计分段：

```text
/repo/src/lib/file.ts
  -> { display: "/", target: "/", reveal: "/repo" }
  -> { display: "repo", target: "/repo", reveal: "/repo/src" }
  -> { display: "src", target: "/repo/src", reveal: "/repo/src/lib" }
  -> { display: "lib", target: "/repo/src/lib", reveal: "/repo/src/lib/file.ts" }
  -> { display: "file.ts", target: "/repo/src/lib/file.ts", open: true }
```

目录分段的 `reveal` 是下一级子项；点击目录时打开其父目录并选中该子项。最后一段
使用 `open: true`，不经过 reveal，而是调用现有的 `open_path`。

Windows 盘符和 UNC 根需要作为不可拆前缀处理：

```text
F:\repo\src\main.rs
\\server\share\repo\file.txt
```

Unix `/`、相对路径和 `~/` 路径使用相同累计规则。相对路径和 `~/` 在发送 IPC 前
按当前 tab cwd 或用户主目录展开。

## Link rendering

现有 xterm link provider仍负责识别完整路径和清理末尾标点、行列号。识别后：

1. 解析行列号之前的纯路径；
2. 生成累计目录分段和最后一段；
3. 用原文本字符索引映射到 xterm cell 范围；
4. 为每个实际显示的路径组件注册独立、互不重叠的 link range；
5. 目录分段使用 reveal 激活，最后一段使用 open 激活。

CJK 宽字符继续使用现有字符索引到 cell 列映射，不能按 UTF-16 或字节长度直接计算。
URL 不进入路径分段器，仍作为一个整体链接。

## Backend operations

新增独立命令而不是给 `open_path` 混入布尔模式：

```text
open_path(path)
  -> open file or directory with the default application

reveal_path(path)
  -> open the parent directory and select path
```

平台实现：

- macOS：`open -R <path>`；
- Windows：`explorer.exe /select,<path>`；
- Linux：优先使用文件管理器 D-Bus `ShowItems`，失败时 `xdg-open` 父目录。

两个命令复用现有绝对路径/URL 校验、`~/` 展开和平台错误映射。`reveal_path` 只接受
绝对文件系统路径，不接受任意 URL scheme。

## Interaction and safety

- 点击目录分段消费该次点击，避免进入文本选区。
- 点击最后一段文件调用 `open_path`。
- 点击路径之外保持现有选择、复制和 TCodex safe-mouse 行为。
- TCodex 的 mouse-report filtering 仍是最后保护层；路径点击不能发送 PTY 鼠标报告。
- 相对路径使用该 tab 当前的本地 cwd，远程 endpoint 路径不在本次范围。

## Verification strategy

- 纯函数测试覆盖 Unix、Windows 盘符、UNC、相对路径、`~/`、尾标点和
  `path:line:column`。
- Rust 单元测试验证 reveal 参数规划和 URL 拒绝；实际系统打开在远端 Windows 做
  GUI 验证。
- 运行 terminal link、mouse、`svelte-check`、GUI 构建和 Rust GUI checks。
- 远端 Windows 创建临时目录和文件，在真实 TCodex 输出路径；点击父目录后检查
  Explorer 启动参数包含 `/select,<child>`，点击文件名后检查默认打开程序收到文件路径。

## Risks

- 分段链接数量增加可能影响超长路径的链接命中。只生成可见文本范围内的链路，并保持
  分段互不重叠。
- Windows Explorer 对 `/select,` 参数和逗号、空格路径敏感。参数必须作为单个参数
  传递且在远端真实路径上验证。
- Linux 文件管理器 reveal 能力不一致，允许明确降级为打开父目录。

## Rollback

移除分段链接并让整个路径恢复调用 `open_path`；不涉及数据格式或持久化迁移。
