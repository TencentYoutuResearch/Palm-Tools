# Flutter App 与 Kode 后端通信诊断报告

## 问题 1: TokensDto 字段不完整（严重）

### Rust 侧（Bridge）- `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 468-471 行**：TokensDto 定义
```rust
#[derive(Default, Serialize)]
struct TokensDto {
    total: u64,
}
```

**问题**：只定义了 `total` 字段

### Flutter 侧（Dart）- `/Users/marxwang/Projects/youtu/app/kode/apps/mobile/lib/src/protocol/protocol.dart`

**第 85-99 行**：TokensDto 定义
```dart
class TokensDto {
  final int input, output, cached, total;
  TokensDto({
    this.input = 0,
    this.output = 0,
    this.cached = 0,
    this.total = 0,
  });
  factory TokensDto.fromJson(Map<String, dynamic> j) => TokensDto(
        input: (j['input'] as num?)?.toInt() ?? 0,
        output: (j['output'] as num?)?.toInt() ?? 0,
        cached: (j['cached'] as num?)?.toInt() ?? 0,
        total: (j['total'] as num?)?.toInt() ?? 0,
      );
}
```

**问题**：期望 `input`, `output`, `cached`, `total` 四个字段

### 根本原因
- Rust 侧只返回 `total`
- Flutter 侧期望 `input` + `output` + `cached` + `total`
- 客户端解析时，`input/output/cached` 收到 null，默认 0，丢失信息

### 协议规范
PROTOCOL.md §4.1 明确指出：
```json
"tokens": { "input": 1024, "output": 256, "cached": 0, "total": 1280 }
```

---

## 问题 2: Bridge 不返回 `session_uuid` 字段（中等）

### Rust 侧 - `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 482-496 行**：session_to_dto 实现
```rust
fn session_to_dto(s: &Session) -> SessionDto {
    SessionDto {
        id: s.id,
        backend_key: s.backend_key.clone(),
        title: s.state.title.clone(),
        model: s.state.model.clone(),
        status: status_label(s.state.status),
        cwd: Some(s.cwd.to_string_lossy().into_owned()),
        session_uuid: s.session_id.clone(),    // ← 这行正确
        tokens: TokensDto {
            total: s.state.tokens.unwrap_or(0),
        },
        context_pct: None,
        cost_usd: s.state.cost_usd,
    }
}
```

看起来正确。但需要验证：session_id 是否真的被正确设置。

---

## 问题 3: Bridge 丢失字段：`input_tokens`, `output_tokens`, `cached_tokens`

### Rust 侧 - `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 302-345 行**：spawn_event_router 中 JsonlMeta 事件处理
```rust
CoreEvent::JsonlMeta {
    id,
    model,
    title,
    session_uuid,
    tokens,
    input_tokens,      // ← 接收到了
    output_tokens,     // ← 接收到了
    cached_tokens,     // ← 接收到了
    cost_usd,
    context_pct,
    ..
} => {
    // ...
    ctx.bus.emit(EventEnvelope::new(
        id,
        "meta",
        json!({
            "model": model,
            "title": title,
            "session_uuid": session_uuid,
            "tokens": tokens,
            "input_tokens": input_tokens,      // ← 正确转发
            "output_tokens": output_tokens,    // ← 正确转发
            "cached_tokens": cached_tokens,    // ← 正确转发
            "cost_usd": cost_usd,
            "context_pct": context_pct,
        }),
    ));
}
```

**好消息**：WS `meta` 事件中包含分解的 token 字段。

**问题**：REST `/sessions` 列表返回的 TokensDto 仍然只有 `total`。

---

## 问题 4: POST /api/v1/sessions/:id/mode 接口返回值不匹配

### Rust 侧 - `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 788-792 行**：ModeResp 定义
```rust
#[derive(Serialize)]
struct ModeResp {
    mode: String,
    cycles: u32,
}
```

### Flutter 侧 - `/Users/marxwang/Projects/youtu/app/kode/apps/mobile/lib/src/api/api_client.dart`

**第 141-148 行**：setMode 实现
```dart
Future<String> setMode(int id, String mode) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/mode',
      data: {'mode': mode},
    );
    _check(resp);
    return resp.data['mode'] as String;
}
```

**问题**：Bridge 返回 `{mode, cycles}`，Flutter 正确提取 `mode` 字段。✓ 此处无问题

---

## 问题 5: POST /api/v1/sessions/:id/plan_response 未实现

### Rust 侧 - `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 726-735 行**：post_plan_response 实现
```rust
async fn post_plan_response(
    Extension(_ctx): Extension<Arc<Ctx>>,
    Path(_id): Path<SessionId>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let _ = body;
    Err(ApiError::Internal(
        "plan_response endpoint pending semantic-layer impl".into(),
    ))
}
```

**问题**：明确返回 500，任何调用都会失败。

### Flutter 侧 - `/Users/marxwang/Projects/youtu/app/kode/apps/mobile/lib/src/api/api_client.dart`

**第 127-135 行**：postPlanResponse 实现
```dart
Future<void> postPlanResponse(int id, String planId, bool accept) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/plan_response',
      data: {'plan_id': planId, 'accept': accept},
    );
    _check(resp);
}
```

**问题**：调用会失败，用户无法接受或拒绝 plan。

---

## 问题 6: POST /api/v1/sessions/:id/answer 参数 question_id 注释说 500

### Flutter 侧 - `/Users/marxwang/Projects/youtu/app/kode/apps/mobile/lib/src/api/api_client.dart`

**第 110-125 行**：postAnswer 实现
```dart
/// 协议 §4.6 — 回答 AskUserQuestion。
/// **当前 Rust bridge 占位 500**;Go server 也是同样状态。
/// 真实 PTY 编码尚未确定 → 这个方法会因 server 返 500 而抛 ApiException。
Future<void> postAnswer(int id, String questionId, int choiceIndex,
    {String? freeText}) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/answer',
      data: {
        'question_id': questionId,
        'choice_index': choiceIndex,
        if (freeText != null) 'free_text': freeText,
      },
    );
    _check(resp);
}
```

### Rust 侧 - `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 698-724 行**：post_answer 实现
```rust
async fn post_answer(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<AnswerReq>,
) -> Result<StatusCode, ApiError> {
    let _ = req.question_id;  // ← 忽略了
    let _ = req.free_text;    // ← 忽略了
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
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.attention_cleared",
        json!({ "reason": "user_answered_via_api" }),
    ));
    Ok(StatusCode::NO_CONTENT)
}
```

**问题**：接收 `question_id` 但忽略它，只发送数字到 PTY。功能有效但不完整。

---

## 问题 7: CreateSessionReq 缺少 `permission_mode`（实际有，但命名不一致）

### Rust 侧 - `/Users/marxwang/Projects/youtu/app/kode/crates/kode-bridge/src/lib.rs`

**第 504-514 行**：CreateSessionReq 定义
```rust
#[derive(Deserialize)]
struct CreateSessionReq {
    backend_key: String,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    resume_session_uuid: Option<String>,
    permission_mode: Option<String>,
    model: Option<String>,
    memory_context: Option<String>,
}
```

✓ 有 `permission_mode`

### Flutter 侧 - `/Users/marxwang/Projects/youtu/app/kode/apps/mobile/lib/src/api/api_client.dart`

**第 150-168 行**：createSessionWithMode 实现
```dart
Future<SessionDto> createSessionWithMode({
    required String backendKey,
    String? cwd,
    String? resumeSessionUuid,
    String? permissionMode,
  }) async {
    final resp = await _dio.post(
      '/api/v1/sessions',
      data: {
        'backend_key': backendKey,
        if (cwd != null) 'cwd': cwd,
        if (resumeSessionUuid != null) 'resume_session_uuid': resumeSessionUuid,
        if (permissionMode != null) 'permission_mode': permissionMode,
      },
    );
    _check(resp);
    return SessionDto.fromJson(resp.data as Map<String, dynamic>);
}
```

✓ 匹配

---

## 问题 8: 缺少 `model` 字段传递

### Rust 侧支持
Bridge **接受** `model` 参数在 CreateSessionReq 中（第 512 行），传给 Session::new（第 548 行）。

### Flutter 侧
apiClient 没有提供设置 model 的方法在 createSession 调用中。

---

## 问题 9: 缺少 `memory_context` 字段

### Rust 侧支持
Bridge **接受** `memory_context` 参数（第 513 行），传给 Session::new（第 550 行）。

### Flutter 侧
完全没有暴露此字段。

---

## 问题 10: 缺失的 REST 端点不匹配

### 根据 PROTOCOL.md §4.11：需要 `/api/v1/fs/list` 

### Rust 侧实现
✓ 已实现（第 1071-1111 行）

### Flutter 侧
虽然有 fs_list 调用代码注释，但 apiClient 里**无此方法定义**，应添加。

---

## 总结表

| # | 问题 | 严重级别 | 影响 |
|----|------|---------|------|
| 1 | TokensDto 缺少 input/output/cached 字段 | 🔴 严重 | 手机端显示空 token 统计 |
| 2 | POST /answer - question_id 被忽略 | 🟡 中等 | 功能可用但不完整 |
| 3 | POST /plan_response 未实现(500) | 🔴 严重 | 手机用户无法回答 plan |
| 4 | createSession 缺少 model 参数 | 🟡 中等 | 无法预设 model |
| 5 | createSession 缺少 memory_context 参数 | 🟡 中等 | 无法配置 memory |
| 6 | 缺少 fs/list 端点在 apiClient | 🟠 轻 | UI 无法浏览目录 |

---

## 修复优先级

1. **立即修复**：
   - 问题 1：扩展 TokensDto 为四字段版本
   - 问题 3：实现 POST /plan_response

2. **近期修复**：
   - 问题 2：记录 question_id 以备后续
   - 问题 4-5：添加 Flutter 侧的参数支持

3. **后续优化**：
   - 问题 6：完整的文件浏览 UI

