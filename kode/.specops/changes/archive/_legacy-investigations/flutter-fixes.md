# Flutter 与 Kode Bridge 协议不匹配 — 修复建议

## 修复方案概览

本文档提供具体的代码修复方案，按优先级排列。

---

## 修复 1：扩展 TokensDto 支持分解字段（严重）

### 当前问题
- Rust: 只返回 `{ total: u64 }`
- Dart: 期望 `{ input, output, cached, total }`
- 结果：token 统计信息丢失

### 修复步骤

#### A. 修改 Rust 侧 (`/crates/kode-bridge/src/lib.rs`)

**第 468-471 行** - 替换 TokensDto 结构体：

```rust
#[derive(Default, Serialize)]
struct TokensDto {
    input: u64,      // 新增
    output: u64,     // 新增
    cached: u64,     // 新增
    total: u64,
}
```

**第 482-496 行** - 更新 session_to_dto 函数：

```rust
fn session_to_dto(s: &Session) -> SessionDto {
    SessionDto {
        id: s.id,
        backend_key: s.backend_key.clone(),
        title: s.state.title.clone(),
        model: s.state.model.clone(),
        status: status_label(s.state.status),
        cwd: Some(s.cwd.to_string_lossy().into_owned()),
        session_uuid: s.session_id.clone(),
        tokens: TokensDto {
            input: 0,    // 从 meta 事件拉
            output: 0,   // 从 meta 事件拉
            cached: 0,   // 从 meta 事件拉
            total: s.state.tokens.unwrap_or(0),
        },
        context_pct: None,
        cost_usd: s.state.cost_usd,
    }
}
```

**更好方案**：Session 状态中存储分解字段

在 Session struct 中（`kode-core/src/session/mod.rs`）添加：
```rust
pub struct SessionState {
    // ... 现有字段 ...
    pub tokens_input: Option<u64>,
    pub tokens_output: Option<u64>,
    pub tokens_cached: Option<u64>,
}
```

然后在 `session_to_dto` 中：
```rust
tokens: TokensDto {
    input: s.state.tokens_input.unwrap_or(0),
    output: s.state.tokens_output.unwrap_or(0),
    cached: s.state.tokens_cached.unwrap_or(0),
    total: s.state.tokens.unwrap_or(0),
}
```

#### B. Dart 侧已正确（无需改动）

`protocol.dart` 的 TokensDto 已经期望四个字段，无需改动。

### 测试方法
```bash
curl -H "Authorization: Bearer <token>" http://localhost:9870/api/v1/sessions | jq '.sessions[0].tokens'
# 应该返回：
# { "input": 1024, "output": 256, "cached": 0, "total": 1280 }
```

---

## 修复 2：实现 POST /api/v1/sessions/:id/plan_response（严重）

### 当前问题
- Rust 侧返回固定 500 错误
- 手机用户无法接受或拒绝 plan

### 修复步骤

#### 修改 Rust 侧 (`/crates/kode-bridge/src/lib.rs` 第 726-735 行)

**替换为实现版本**：

```rust
#[derive(Deserialize)]
struct PlanResponseReq {
    plan_id: String,
    accept: bool,
}

async fn post_plan_response(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<PlanResponseReq>,
) -> Result<StatusCode, ApiError> {
    let g = ctx.sessions.lock();
    let s = g
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("session {id}")))?;
    
    // 根据 accept 状态发送对应序列到 PTY
    // accept=true → 模拟按 'a' 接受
    // accept=false → 模拟按 'r' 拒绝
    // （具体按键码待确认 codebuddy/claude 的 ExitPlanMode 实现）
    let key = if req.accept { b'a' } else { b'r' };
    s.write_input(&[key]);
    
    drop(g);
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.plan_responded",
        json!({ "plan_id": req.plan_id, "accept": req.accept }),
    ));
    
    Ok(StatusCode::NO_CONTENT)
}
```

**注意**：真实的 PTY 按键码需要从 codebuddy/claude 的源码或运行时行为确认。

### 测试方法
```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"plan_id":"plan-123","accept":true}' \
  http://localhost:9870/api/v1/sessions/1/plan_response
# 应该返回 204 No Content
```

---

## 修复 3：记录 question_id 在 answer 处理中（中等）

### 当前问题
- question_id 被接收但忽略
- 无法关联回答与问题

### 修改步骤

#### 修改 Rust 侧 (`/crates/kode-bridge/src/lib.rs` 第 698-724 行)

**替换为**：

```rust
#[derive(Deserialize)]
struct AnswerReq {
    question_id: Option<String>,
    choice_index: u32,
    free_text: Option<String>,
}

async fn post_answer(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<AnswerReq>,
) -> Result<StatusCode, ApiError> {
    if req.choice_index > 8 {
        return Err(ApiError::BadRequest(format!(
            "choice_index out of range: {} (max 8)",
            req.choice_index
        )));
    }
    
    let digit = char::from_digit(req.choice_index + 1, 10).expect("0..=8 is valid") as u8;
    
    let g = ctx.sessions.lock();
    let s = g
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("session {id}")))?;
    s.write_input(&[digit]);
    drop(g);
    
    // 发送 answer_submitted 事件，记录 question_id
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.answer_submitted",
        json!({
            "question_id": req.question_id,
            "choice_index": req.choice_index,
            "free_text": req.free_text,
        }),
    ));
    
    // 后续由 scan_loop 检测到 prompt 消失时发送 attention_cleared
    
    Ok(StatusCode::NO_CONTENT)
}
```

---

## 修复 4：支持预设 model（中等）

### 当前问题
- Rust 侧 CreateSessionReq 接受 model，但 Flutter 没有暴露

### 修改步骤

#### A. Flutter 侧 (`/apps/mobile/lib/src/api/api_client.dart`)

**第 67-82 行** - 修改 createSession 方法添加 model 参数：

```dart
Future<SessionDto> createSession({
    required String backendKey,
    String? cwd,
    String? resumeSessionUuid,
    String? model,           // 新增
  }) async {
    final resp = await _dio.post(
      '/api/v1/sessions',
      data: {
        'backend_key': backendKey,
        if (cwd != null) 'cwd': cwd,
        if (resumeSessionUuid != null) 'resume_session_uuid': resumeSessionUuid,
        if (model != null) 'model': model,  // 新增
      },
    );
    _check(resp);
    return SessionDto.fromJson(resp.data as Map<String, dynamic>);
  }
```

#### B. Flutter 侧 - 合并 createSession 与 createSessionWithMode

**建议**：将两个方法合并为一个完整方法：

```dart
Future<SessionDto> createSession({
    required String backendKey,
    String? cwd,
    String? resumeSessionUuid,
    String? permissionMode,
    String? model,
    String? memoryContext,   // 见修复 5
  }) async {
    final resp = await _dio.post(
      '/api/v1/sessions',
      data: {
        'backend_key': backendKey,
        if (cwd != null) 'cwd': cwd,
        if (resumeSessionUuid != null) 'resume_session_uuid': resumeSessionUuid,
        if (permissionMode != null) 'permission_mode': permissionMode,
        if (model != null) 'model': model,
        if (memoryContext != null) 'memory_context': memoryContext,
      },
    );
    _check(resp);
    return SessionDto.fromJson(resp.data as Map<String, dynamic>);
  }
```

然后删除 `createSessionWithMode`，所有调用统一用这个方法。

---

## 修复 5：支持 memory_context 参数（中等）

### 当前问题
- Rust 侧接受但 Flutter 没有暴露

### 修改步骤

#### Flutter 侧
见修复 4 中 createSession 的完整版本，已包含 memoryContext 参数。

---

## 修复 6：添加 fs/list 端点调用（轻）

### 当前问题
- Rust 侧已实现，Flutter 无调用方法

### 修改步骤

#### Flutter 侧 (`/apps/mobile/lib/src/api/api_client.dart`)

**添加新方法**：

```dart
/// 列举目录内容（用于选择 cwd）
Future<FsListResult> fsList(String path, {bool showHidden = false}) async {
  final resp = await _dio.get(
    '/api/v1/fs/list',
    queryParameters: {
      'path': path,
      'show_hidden': showHidden,
    },
  );
  _check(resp);
  return FsListResult.fromJson(resp.data as Map<String, dynamic>);
}
```

**添加数据类**（在 `protocol.dart`）：

```dart
class FsListResult {
  final String path;
  final String? parent;
  final List<FsEntry> entries;

  FsListResult({
    required this.path,
    required this.parent,
    required this.entries,
  });

  factory FsListResult.fromJson(Map<String, dynamic> j) => FsListResult(
    path: j['path'] as String,
    parent: j['parent'] as String?,
    entries: (j['entries'] as List?)
        ?.map((e) => FsEntry.fromJson(e as Map<String, dynamic>))
        .toList() ??
        const [],
  );
}

class FsEntry {
  final String name;
  final bool isDir;

  FsEntry({required this.name, required this.isDir});

  factory FsEntry.fromJson(Map<String, dynamic> j) => FsEntry(
    name: j['name'] as String,
    isDir: j['is_dir'] as bool? ?? false,
  );
}
```

---

## 修复 7：添加缺失的 SessionDto 字段（轻）

### 验证

根据 PROTOCOL.md §4.1，SessionDto 应包含 `created_at` 字段。

检查 Rust 侧是否有此字段：

```bash
grep -n "created_at" /Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs
```

如果没有，添加：

```rust
struct SessionDto {
    // ... 现有字段 ...
    created_at: Option<String>,  // RFC3339 format
}
```

对应 Dart 侧：

```dart
class SessionDto {
  // ... 现有字段 ...
  final String? createdAt;  // ISO 8601 string
}
```

---

## 测试清单

### 1. 单元测试（Rust 侧）

添加到 `crates/kode-bridge/src/lib_tests.rs`：

```rust
#[tokio::test]
async fn test_tokens_dto_serialization() {
    let dto = TokensDto {
        input: 1024,
        output: 256,
        cached: 0,
        total: 1280,
    };
    let json = serde_json::to_value(&dto).unwrap();
    assert_eq!(json["input"], 1024);
    assert_eq!(json["output"], 256);
    assert_eq!(json["cached"], 0);
    assert_eq!(json["total"], 1280);
}

#[tokio::test]
async fn test_session_dto_has_tokens() {
    // 创建 session 后列出，验证 tokens 字段完整
    let resp = client.get("/api/v1/sessions").send().await;
    let sessions = resp.json::<SessionsResp>().await;
    assert!(!sessions.sessions.is_empty());
    let s = &sessions.sessions[0];
    assert!(s.tokens.input >= 0);
    assert!(s.tokens.output >= 0);
}
```

### 2. 集成测试（Dart 侧）

```dart
test('listSessions returns complete TokensDto', () async {
  final sessions = await client.listSessions();
  expect(sessions, isNotEmpty);
  final tokens = sessions[0].tokens;
  expect(tokens.input, isA<int>());
  expect(tokens.output, isA<int>());
  expect(tokens.cached, isA<int>());
  expect(tokens.total, isA<int>());
});

test('postPlanResponse succeeds', () async {
  await client.postPlanResponse(sessionId, planId, true);
  // 应不抛异常
});
```

### 3. 手工测试脚本

```bash
#!/bin/bash

TOKEN=$(cat ~/.kode/state.json | jq -r '.bridge_token')
BASE_URL="http://localhost:9870"

# 测试 GET /sessions
echo "=== Test 1: GET /sessions ==="
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/sessions" | jq '.sessions[0].tokens'

# 测试 POST /sessions/:id/plan_response
echo "=== Test 2: POST /plan_response ==="
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan_id":"test-123","accept":true}' \
  "$BASE_URL/api/v1/sessions/1/plan_response"

# 测试 GET /fs/list
echo "=== Test 3: GET /fs/list ==="
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/v1/fs/list?path=$HOME" | jq '.entries'
```

---

## 合并建议

### Phase 1（本周）
1. 修复 1：TokensDto 完整字段
2. 修复 2：实现 plan_response
3. 修复 3：记录 question_id

### Phase 2（下周）
1. 修复 4-5：model + memory_context
2. 修复 6：fs/list 端点

### Phase 3（可选）
1. 修复 7：created_at 字段
2. 添加完整端到端测试

---

## 相关文件总结

### Rust 侧需修改的文件
- `/crates/kode-bridge/src/lib.rs`（主文件，所有修复）
- `/crates/kode-core/src/session/mod.rs`（可选：添加分解 token 字段）

### Dart 侧需修改的文件
- `/apps/mobile/lib/src/api/api_client.dart`（添加/修改方法）
- `/apps/mobile/lib/src/protocol/protocol.dart`（添加数据类）

### 协议文档
- `/docs/PROTOCOL.md`（验证后续是否需要更新）

---

## 审查清单

在提交 PR 前：

- [ ] 所有修复都有对应单元测试
- [ ] TokensDto 四字段序列化正确
- [ ] plan_response 实际按键码已确认
- [ ] question_id 完整保留在事件中
- [ ] fs/list 端点可正常调用
- [ ] 手工测试脚本全通过
- [ ] PROTOCOL.md 无过期说法

