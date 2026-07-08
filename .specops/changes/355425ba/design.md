# 设计决策

## 策略选择:后处理 + 容错

**决定**: 在 vt100-ctt 上游做 UTF-8 缓冲修复，不替换终端模拟器。

**Why**:
- vt100-ctt 是经过广泛测试的成熟终端模拟器，替换成本极高
- 乱码主要发生在字节流边界（PTY read chunk 切断了多字节 UTF-8 序列），不在 vt100-ctt 内部
- 在 feed 前做轻量级 UTF-8 拼接即可消除大部分问题，改动量极小

## UTF-8 缓冲位置:Session::feed

**决定**: 在 `Session::feed()` 中添加 `feed_remnant` 缓冲，而非在 PTY reader 线程。

**Why**:
- PTY reader 是同步线程（`std::thread::spawn`），加缓冲需要引入 `Mutex`，增加复杂度
- `Session::feed()` 是字节进入 vt100 parser 的最后一站，在这里做保护最可靠
- 一次修复同时覆盖 TUI 和 GUI 两端的 vt100 解析

## 缓冲大小

**决定**: 使用 `Vec<u8>` 动态分配，不做固定大小数组。

**Why**:
- UTF-8 最长序列仅 4 字节，但实际场景中 remnant 平均 < 2 字节
- `Vec<u8>` 用 `with_capacity(8)` 初始化，避免小对象频繁分配
- 代码更简洁，不需要手动维护长度/容量

## Coalesce 层也做保护

**决定**: 在 GUI coalesce loop 中也添加 UTF-8 边界检查。

**Why**:
- 防御纵深：即使 Session::feed 因某些原因漏了截断字节，coalesce 层作为第二道防线
- xterm.js 接收不完整 UTF-8 序列的行为不确定（取决于 JS 的 TextDecoder 实现），应该避免
- 实现极简：复用同一个 `split_at_complete_utf8` 工具函数

## 不处理 ANSI 序列截断

**决定**: 不专门处理 ANSI 转义序列跨 chunk 截断。

**Why**:
- 概率极低：ANSI 序列通常很短（< 20 字节），几乎不可能被 8KB chunk 边界切断
- VTE 状态机本身有序列缓冲和超时恢复机制
- UTF-8 缓冲修复间接减轻了问题（因为 ANSI 序列字节都在 ASCII 范围，不会与 UTF-8 续字节混淆）
- 如果将来遇到，再加专项修复
