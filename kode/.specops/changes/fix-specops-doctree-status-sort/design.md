# 设计说明

## 方案：前端 DocTree 组内排序

唯一改动文件：`apps/specops/frontend/src/components/iwiki/DocTree.svelte`

### 变更点

1. 导入 `DocumentStatus` 类型（已在 `types.ts` 中定义）
2. 新增 `statusPriority` 常量，定义 status 排序权重
3. 在 `groups` derived 中，对每个 bucket 的 `entries[]` 调用 `.sort()` 按 status 优先级排序

### 排序优先级

```
active:    0  (最优先)
proposed:  1
completed: 2
draft:     3
archived:  4
未知:     99 (降级到组尾)
```

### 为什么不改后端

- DocTree 是唯一的文档列表消费者
- 后端 flat sort（mtime 降序）是 API 的通用排序，改变它会影响未预期的消费者
- 前端改动的风险最低：单文件、几行代码、无数据流变更

### 为什么不加 mtime 二级排序

同 status 的文档当前按原来 mtime 顺序排列，这是自然的。如果后续需要同 status 内按最新优先，可以在排序函数内加 mtime 作为第三级比较键。
