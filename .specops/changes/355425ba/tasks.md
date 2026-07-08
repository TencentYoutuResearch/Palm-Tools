# Tasks

- [ ] 添加 UTF-8 序列边界检测工具函数（`utf8_sequence_len` + `split_at_complete_utf8`）到 `crates/kode-core/src/session/mod.rs`
- [ ] Session::feed 层 UTF-8 缓冲：添加 `feed_remnant: Vec<u8>` 字段，修改 `feed()` 在 process 前拼接截断字节
- [ ] GUI coalesce 层 UTF-8 保护：`spawn_coalesce_loop` 发出前检测末尾截断，保留到下一 tick
- [ ] Snapshot UTF-8 加固：`get_screen_snapshot` 严格 UTF-8 校验替代 `from_utf8_lossy`
- [ ] 单元测试：UTF-8 截断场景（2/3/4 字节各 1 种切法）
- [ ] 集成测试：快速连续写 PTY → 检查屏幕不含替换字符
- [ ] 跑全量测试确认无回归（`cargo test -- --test-threads=1`）
