---
schema_version: 1
id: roadmap/phase-11
kind: spec
title: Phase 11 — Remote Backend in GUI (draft)
status: draft
verifies:
  - rust
  - specops
paths:
  - .specops/specs/remote-protocol.md
  - apps/gui/src-tauri/src/bridge
  - crates/kode-core/src/transport
---

# Phase 11 — Remote Backend in GUI(草稿)

> 2026-06-09 草拟。落地前请与 Phase 9 协议契约对齐;有变更回写 `.specops/specs/remote-protocol.md` 与 `docs/protocol-smoke.sh`。

## 一句话目标

让 kode GUI 既能开本地 PTY tab(默认、零回归),也能开**连远端 `kode-server-go` 的 tab**,远端 codebuddy/claude 在远端跑,字节流与 jsonl 语义事件通过 Phase 9 协议送回 GUI 渲染。

## 不做什么(刻意 out of scope)

- ❌ **本地 tab 走 server 模式** — 本地必须保持 PtyHost 直通 mpsc,不经协议层。否则违反 ROADMAP §484 性能硬指标(PTY → 像素 P99 < 16ms)
- ❌ **GUI 端嵌 ssh transport** — 不写 ssh 包装层。"在远端运行 codebuddy"= "在那台机器上 docker compose up kode-server-go,GUI 连过去"
- ❌ **多客户端同时操作同一 session 的复杂同步** — 沿用 Phase 9 "最后一次 input 赢" 语义,显示当前 active 客户端名即可
- ❌ **远端 backend 自动发现(mDNS / Bonjour)** — 用户手动配 endpoint,扫 QR 等 v1.1 再说
- ❌ **远端文件浏览/上传** — 远端的文件交给远端 codebuddy 处理,GUI 不做远端文件管理器

## 关键不变量(改代码前必读)

1. **本地 tab 不走协议层**:Local 与 Remote 是真正分叉的两条路径,不共享中间字节流通道。`SessionTransport` trait(若引入)只在 Tauri command 入口处分流,不下沉到字节传输路径
2. **协议是真源**:Remote 模式下 GUI 是 client,**唯一**信源是 `.specops/specs/remote-protocol.md`。任何破坏跨实现等价的改动必须先改协议 + smoke 脚本
3. **token 进 keychain**:bearer token 不写 `state.json`(那是给 GUI 自己 bridge 的本地 token 用的);远端 endpoint 的 token 走 `keyring` crate,key 命名 `kode/remote/<endpoint-id>`
4. **远端 cwd 不能用本地原生 picker**:`per_tab_cwd_ux` memory 里那条只对 Local backend 适用;Remote backend 必须由 server 提供目录列举端点(见 11.3 协议补丁)
5. **崩溃域分离**:GUI 崩溃不应连带 kill 远端 session(协议层 DELETE 才 kill)。WS 断开仅停推送,session 在 server 端继续活,重连后从 `/history?from=` 续

## 速览

| 子阶段 | 主题 | 工时 | 状态 |
|---|---|---|---|
| 11.1 | 协议补丁:resize / list backends / list dirs | 0.5 天 | TODO |
| 11.2 | `SessionTransport` 入口分流(不抽字节路径) | 0.5 天 | TODO |
| 11.3 | `RemoteTransport`:reqwest + tokio-tungstenite + 自动重连 | 1 天 | TODO |
| 11.4 | Endpoint 配置 + token 存 keychain + 配对 UI | 0.5 天 | TODO |
| 11.5 | BackendChooser 双分组 UI(本地 / 远端) | 0.5 天 | TODO |
| 11.6 | 状态栏:连接状态指示 + 断线重连提示 | 0.25 天 | TODO |
| 11.7 | 端到端验证:Tailscale 真机 + 12 步 smoke 等价 | 0.25 天 | TODO |

**预估**:3 天 + 半天联调缓冲 = **3.5 天**。

---

## Phase 11.1 — 协议补丁(0.5 天)

Phase 9 协议为手机优先设计,有几个 GUI 必需端点缺失:

### 11.1.1 — `POST /api/v1/sessions/:id/resize`

GUI 终端会 resize(窗口拉伸 / 拆分面板 / 进入 zoomed mode);手机端不会,所以 9.0 没定义。

```
POST /api/v1/sessions/:id/resize
{ "cols": 120, "rows": 40 }
→ 204 No Content
```

server 端调 `pty.Setsize(ptyf, &pty.Winsize{Rows, Cols})`(creack/pty 已有)+ Rust bridge 端调 `PtyHost::resize`。

- [ ] `.specops/specs/remote-protocol.md` 加端点定义
- [ ] Go server `internal/session/session.go` 加 `Resize(cols, rows uint16)` + handler
- [ ] Rust bridge `bridge/router.rs` 同步实现
- [ ] `docs/protocol-smoke.sh` 第 13 步:resize → get → 字段一致(server 不强制持久化 size,但 resize 不应报错)
- [ ] 验收:跨实现 12 步 → 13 步全过

### 11.1.2 — `GET /api/v1/backends`

客户端要知道远端注册了哪些 backend(`codebuddy` / `claude` / `claude-haiku` / 自定义)及其 metadata。

```
GET /api/v1/backends
→ 200 { "backends": [
    { "key": "codebuddy", "display_name": "codebuddy",
      "supports_cwd": true, "default_cwd": "/home/dev/code" },
    { "key": "claude", "display_name": "claude", ... }
  ]}
```

- [ ] 协议加端点
- [ ] Go server 从 config.yaml 派生
- [ ] Rust bridge 从 `~/.kode/config.toml` 的 `[backends.*]` 派生(只导出 `transport = "local"` 的)
- [ ] smoke 第 14 步

### 11.1.3 — `GET /api/v1/fs/list?path=<abspath>`

远端 backend 启动需要选 cwd。不做完整文件浏览器,只做"列一个目录的子目录"。

```
GET /api/v1/fs/list?path=/home/dev
→ 200 { "path": "/home/dev",
        "entries": [
          { "name": "code", "is_dir": true },
          { "name": "data", "is_dir": true }
        ],
        "parent": "/home"
      }
```

**约束**:
- 只接受绝对路径;server canonicalize 后确认是一个存在的目录
- 不默认限制 `$HOME` 子树,SSH remote 场景允许 `/data/workspace`、`/mnt` 等有效目录
- 不返回隐藏文件除非 `?show_hidden=true`
- 不返回文件内容、不支持创建/删除目录

- [ ] 协议加端点(声明安全边界)
- [ ] Go server 实现 + 单测覆盖路径越权(`../../etc/passwd` 必须 403)
- [ ] Rust bridge 实现(同样的安全约束;**不**复用本地 picker,要自己写)
- [ ] smoke 第 15 步:正常列举 + 越权 403 + 不存在 404

### 11.1.4 — 协议版本号

新端点加进来,`connection.hello` 的 `protocol_version` 升 `1.1`。客户端可读但旧客户端连新 server 应仍能跑(老端点全保留)。

- [ ] `.specops/specs/remote-protocol.md` Changelog 段加 1.1 entry
- [ ] hello 事件字段更新

---

## Phase 11.2 — `SessionTransport` 入口分流(0.5 天)

**关键设计选择**:trait 在 Tauri command 边界分流,**不**下沉到字节流传输路径。

### 不要这样做(反例)

```rust
// ❌ 把 trait 抽到字节流层 — 本地 PTY 被迫绕一圈 broadcast,延迟变 ms 级
trait SessionTransport {
    fn bytes_stream(&self) -> impl Stream<Item = Vec<u8>>;
}
```

### 应该这样做

```rust
// ✅ trait 只管"开 session / 关 session / 写 input",字节流回路由实现各自决定
// crates/kode-core/src/transport/mod.rs (新建)
#[async_trait]
pub trait SessionTransport: Send + Sync {
    async fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedSession>;
    async fn write_input(&self, sid: SessionId, bytes: &[u8]) -> Result<()>;
    async fn resize(&self, sid: SessionId, cols: u16, rows: u16) -> Result<()>;
    async fn kill(&self, sid: SessionId) -> Result<()>;
}

pub struct SpawnedSession {
    pub id: SessionId,
    pub session_uuid: Option<String>,
    pub model: Option<String>,
    // 注意:没有 stream 字段。字节流由实现自己挂到 BridgeBus
}
```

### 实现

- [ ] `LocalTransport`:**包装现有** `bridge::ctx::BridgeCtx` 的 spawn/write/kill 路径,**不动**字节通道。`spawn` 内部仍然走 `PtyHost::spawn` + 把 `CoreEvent` 灌进现有 `BridgeBus`
- [ ] `RemoteTransport`:见 11.3
- [ ] `state.rs::AppState` 新增 `transports: HashMap<EndpointId, Arc<dyn SessionTransport>>`,`EndpointId::Local` 指向 LocalTransport
- [ ] Tauri command `spawn_session` 接受 `endpoint_id` 参数,从 map 取 transport 调用
- [ ] **回归门槛**:Local 路径性能测试(单 tab 空闲 CPU < 0.5%、PTY → 像素 P99 < 16ms)必须与 Phase 7 持平,差超 10% 视为引入回归

---

## Phase 11.3 — `RemoteTransport`(1 天)

### 11.3.1 — REST + WS 客户端骨架

复用 Phase 9.2 Flutter `lib/src/api/api_client.dart` 的设计思路(已经在生产):
- REST 用 `reqwest` (rustls-tls,与 dev-deps 一致)
- WS 用 `tokio-tungstenite`
- 25s ping/pong,断线 exponential backoff(1s / 2s / 5s / 10s / 30s 封顶)
- 重连后调 `/history?from=<last_event_ts_ms>` 拉漏掉的事件

```rust
// crates/kode-core/src/transport/remote.rs (新建)
pub struct RemoteTransport {
    endpoint: Url,
    token: SecretString,           // zeroize on drop
    http: reqwest::Client,
    ws_state: Arc<RwLock<WsState>>,
    bus: BridgeBus,                // 复用现有 bus,字节事件灌进去
}
```

### 11.3.2 — WS 事件 → BridgeBus 适配

`.specops/specs/remote-protocol.md` 的事件类型映射到 `CoreEvent`:

| 协议事件 | CoreEvent |
|---|---|
| `session.created` | (本地侧已有 SpawnSpec,只更新 session_uuid) |
| `session.exited` | `PtyExited { id, code }` |
| `meta` | `JsonlMeta { id, model, title, tokens }` |
| `message` / `tool_use` | (Phase 11 不进 GUI,留给后续 agent UI) |
| **没有** `pty_bytes` | 见下方 |

### 11.3.3 — 字节流通道(协议补充点)

Phase 9 协议**故意没暴露 raw PTY bytes**,只推语义事件给手机用。GUI 渲染需要 raw bytes,得加:

```
WS 事件:
{ "type": "pty_bytes", "session_id": 1, "bytes_b64": "..." }
```

- [ ] 协议加 `pty_bytes` 事件类型(标 `audience: terminal_clients`,手机可忽略)
- [ ] Go server `internal/server/server.go` 在 PTY reader goroutine 把 raw bytes 编 base64 推 WS,与现有 jsonl 解析并行(双 tail 不互相干扰,与 9.1.4 同思路)
- [ ] Rust bridge 同步实现(从 `BridgeBus` 拿 `PtyBytes` 事件转 WS 帧)
- [ ] `RemoteTransport` 收到 `pty_bytes` → decode base64 → 灌入本地 BridgeBus 当 `CoreEvent::PtyBytes` → xterm 渲染

**性能注意**:
- base64 编码膨胀 33%,大输出时占带宽。本地用户场景(loopback / Tailscale 同子网)无所谓,跨公网要谨慎
- coalescing 在 server 端做,默认 8ms(与 GUI 端 byte coalescing 同节奏);可由 `?coalesce_ms=` query 调
- WS 帧大小限制 1 MB,`cat` 大文件超大时分多帧(server 内部切片)

### 11.3.4 — 输入路径

```rust
async fn write_input(&self, sid, bytes) -> Result<()> {
    self.http.post(format!("{}/api/v1/sessions/{}/input", self.endpoint, sid))
        .bearer_auth(&self.token)
        .json(&json!({ "bytes_b64": base64::encode(bytes) }))
        .send().await?;
    Ok(())
}
```

延迟容忍:每次按键一次 HTTP POST 是否合适?

- 本地输入频率 < 100/s,POST 比 WS frame 略贵但简单可靠
- 真量大的是粘贴:粘贴 1 MB 文本 → 单次 POST 一发了之,WS 帧反而要切片
- **决定**:输入走 POST,**不**用 WS upstream。简单 > 微优化

### 11.3.5 — 断线重连不变量

- WS 断开 → 不 emit `PtyExited`(session 在 server 还活着!)
- WS 重连成功 → `GET /history?from=<ts>` 补齐期间漏掉的事件
- 重连失败超 30s → emit `RemoteDisconnected { id }`(GUI 状态栏闪红)
- 用户手动 close tab → DELETE → server 真 kill

### 11.3.6 — 测试

- [ ] `crates/kode-core/tests/remote_transport.rs`:启个 Go server(子进程),起 RemoteTransport,跑 spawn → input → exit
- [ ] WS 断线复连:杀 server 子进程 → 重启 → 拉 history → 状态一致
- [ ] cancel safety:RemoteTransport drop 时所有 in-flight HTTP / WS 任务被 abort

---

## Phase 11.4 — Endpoint 配置 + token 存 keychain + 配对 UI(0.5 天)

### 11.4.1 — config.toml schema

```toml
# ~/.kode/config.toml

[endpoints.dev-server]
url = "https://dev.tail-xxxx.ts.net"
display_name = "公司开发机"
# token 不在这里!走 keychain

[endpoints.home-mac]
url = "http://192.168.1.20:9870"
display_name = "家里 Mac"

# 远端 backend 列表运行时从 GET /api/v1/backends 拉,不在配置里写死
# 本地 backend 仍在 [backends.*],与远端 endpoints 命名空间分开
```

### 11.4.2 — token 存 keychain

- 用 `keyring` crate(macOS Keychain / Linux Secret Service / Windows Credential Manager)
- key 格式:`service="kode-remote"`, `account="<endpoint_id>"`(如 `dev-server`)
- 配对成功后写,删除 endpoint 时删
- **降级**:keyring 不可用 → 提示用户 + 落到 `~/.kode/state.json::remote_tokens`(明文,加 `chmod 600`)+ 状态栏警告

### 11.4.3 — 配对流程

复用 Phase 9.1.2 已有的 QR pairing payload 格式 `kode://pair?host=…&port=…&token=…`:

- 命令面板新增"添加远端 endpoint…"
- 三种添加方式:
  1. **粘贴 pairing URL**(主推:从远端 server admin UI / `kode-server pair` 子命令拷贝)
  2. **扫屏幕 QR**(macOS `screencapture -i` + zbar 解码,可选;复杂度高,v1.1 再说)
  3. **手填 url + token**
- 添加后立即 `GET /healthz` + `GET /api/v1/backends` 双重验证才入库
- 失败给清晰错误(网络 / 401 / TLS / 协议版本不兼容)

- [ ] `apps/gui/src-tauri/src/commands.rs` 加 `endpoint_add / endpoint_remove / endpoint_list / endpoint_test`
- [ ] `apps/gui/src/lib/EndpointDialog.svelte`
- [ ] 测试:pairing URL 解析单测 + endpoint test 端到端

---

## Phase 11.5 — BackendChooser 双分组 UI(0.5 天)

### 视觉设计

```
┌─ 新建 tab ────────────────────────────┐
│  本地                                  │
│    ▸ codebuddy                        │
│    ▸ claude                           │
│    ▸ claude-haiku                     │
│                                        │
│  远端 · 公司开发机 ●(已连)              │
│    ▸ codebuddy                         │
│    ▸ claude                           │
│                                        │
│  远端 · 家里 Mac ○(未连,点击连接)        │
│    ▸ (未知,点击拉取)                    │
│                                        │
│  + 添加远端 endpoint…                  │
└────────────────────────────────────────┘
```

- 远端分组:状态点 ●(已连) / ◐(连接中) / ○(未连) / ✕(连不上)
- 远端 backend 列表 lazy fetch:hover 或选中时调 `GET /api/v1/backends`
- 选中远端 backend 后,弹"选 cwd" 子对话框 → 走 `GET /api/v1/fs/list` 浏览(11.1.3)
- **per_tab_cwd_ux memory 影响**:本地 backend 仍用 NSOpenPanel;远端 backend 用 server 端目录浏览,命名差异要在 UI 文案里讲清楚

- [ ] `apps/gui/src/lib/BackendChooser.svelte` 改造为分组视图
- [ ] `apps/gui/src/lib/RemoteCwdPicker.svelte` 新建
- [ ] 状态点动画 + a11y(aria-label)

---

## Phase 11.6 — 状态栏连接指示 + 断线提示(0.25 天)

- 状态栏右侧多一段 `endpoint · status`,例:`公司开发机 ●` / `家里 Mac ⟳ 重连中(3/5)`
- 当前 active tab 是远端 tab 时高亮该段
- 30s 重连失败弹 toast:`连接到 公司开发机 已丢失,点击重试`
- ESC 取消重连(用户改主意了)

- [ ] `apps/gui/src/lib/StatusBar.svelte` 加 endpoint 段
- [ ] toast 组件复用 Phase 7 已有的

---

## Phase 11.7 — 端到端验证(0.25 天)

### 真机 smoke

跑在两台机器上:
- **客户端**:本机 mac kode GUI(本地 build)
- **server**:远端 Linux(随便一台,Tailscale 接入),docker compose up `kode-server-go`

验收清单:
- [ ] GUI 添加 endpoint(粘 pairing URL)→ 状态点亮
- [ ] 新 tab → 选远端 codebuddy → 选 cwd `/home/dev/code` → spawn 成功
- [ ] 终端能正常输入输出,中文 + emoji + box drawing 视觉与本地 tab 无差异
- [ ] 状态栏 model / title / tokens 与本地一致(因为 server 端也跑了 jsonl 解析)
- [ ] 拉 100 KB 文本不丢字符不撕裂
- [ ] 杀 server 进程 → GUI 显示重连中 → 启 server → 自动重连 → tab 还在(若 server 崩前已通过 sqlite 持久化 session)或 emit exited(若 session 没了)
- [ ] kill tab → server 端 codebuddy 进程真退出(`ps -ef | grep codebuddy` 验证)
- [ ] **跨实现等价**:把 server 换成 Rust bridge(本机另一个 GUI 实例)→ 同上流程都过

### 性能验收(防止 Local 路径回归)

- [ ] 本地 tab 关掉所有远端 endpoint 配置 → 跑 ROADMAP §484 验收(单 tab CPU / 端到端延迟 / dump 100KB),数值与 Phase 7 baseline 持平 ±10%
- [ ] 同时开 1 个本地 tab + 1 个远端 tab → 本地 tab 性能不应被远端 WS 任务影响

---

## 风险与未决事项

- **base64 over WS 带宽**:跨公网时 1 MB raw output → 1.33 MB WS 帧。要不要上 permessage-deflate?WSS 默认不开,server 端要显式 enable。先观察 dogfood 数据,真痛了再开
- **多窗口 / 多客户端**:GUI 多窗口 + Flutter 同时连同一 endpoint 同一 session,WS 都收得到事件,但 input 谁说了算?Phase 9 设计是"最后一次 input 赢",简单但盲;v2 再做 active client 标记
- **TLS 证书**:Tailscale 用户 HTTPS 走 ts.net 证书自动配,公网部署要 caddy + Let's Encrypt。`reqwest` 默认 rustls 验证,自签证书要不要支持?默认拒,加 `[endpoints.foo] insecure_skip_verify = true` 显式开关 + UI 红色警告
- **协议版本不匹配**:旧 GUI 连新 server / 新 GUI 连旧 server。hello 事件带 `protocol_version`,GUI 客户端 1.0 连 1.1 server → 11.1 新端点不可用但旧功能正常;反过来 1.1 GUI 连 1.0 server → 调新端点 404,GUI 要降级处理(disable resize 等)
- **远端 codebuddy 的 MCP setup**:Phase 10 M4.1 在本地启动 banner 提示 codebuddy mcp add memory。**远端 codebuddy 是另一台机器的另一份配置**,kode GUI 不应该也不能管它的 MCP 配置 → banner 只对本地 backend 触发,远端 backend 不弹

## 决策日志

- **2026-06-09 远端方案不走 SSH transport,走 protocol-native client**
  问题:用户问 kode 能否对接 SSH 服务上的 codebuddy
  讨论:
    - (a) **GUI 内嵌 ssh 包装**:`backend.command = "ssh"`,把 ssh -tt 当 PTY 用。否决:能跑通终端但 jsonl tail / model 状态全废,跨 ssh tail brittle,断线重连困难
    - (b) **加 `transport: ssh` 字段**:扩 PtyHost 走 ssh 包装。否决:能修 (a) 一半,但要为 ssh 单独发明 jsonl 远程 tail 协议,工作量与 (c) 接近且产物专用
    - (c) **复用 Phase 9 协议,远端跑 kode-server-go**(选定):server 已实现 PTY 宿主 + jsonl 解析 + 鉴权 + 持久化 + 跨实现等价,GUI 只补一个客户端
  结论:Phase 9 投资本来就把"远端跑 codebuddy"这个能力做完了,Phase 11 只补 GUI 客户端这一边。SSH 用户的真正答案是 docker compose up server,不是把 ssh 当 transport
  附带:协议要补 resize / list backends / list dirs / pty_bytes 四样(11.1)

- **2026-06-09 本地不走 server 模式**(关键不变量 1)
  问题:既然有了 RemoteTransport,本地是否也走它(连 loopback server)统一架构?
  否决:
    - 字节流加 base64 + JSON envelope + WS frame + tokio-tungstenite,延迟从 mpsc 几微秒升到 ms 级,违反 ROADMAP §484 PTY → 像素 P99 < 16ms 硬指标
    - 同机文件读写语义错乱:codebuddy Read/Write 在 server 进程的 cwd,本地用户在 GUI 看不到改动反馈
    - 单进程时崩溃域分离的"好处"在本地不存在(GUI 死了用户也走了)
  结论:Local 与 Remote 是真正分叉的两条路径,只在 Tauri command 入口 trait 分流,不下沉到字节通道。性能验收要明确比较 Phase 7 baseline 防回归

- **2026-06-09 输入走 POST 而非 WS upstream**
  问题:remote 客户端键盘输入用 HTTP POST 还是 WS 上行帧
  量化对比(单次按键):
    - POST:~400-600 B(TLS + JSON envelope),1 RTT,HTTP/2 多路复用 keep-alive 后实际一个 stream frame
    - WS 上行:~10-20 B frame header,~1 RTT
    - **真实差距**:本地 / Tailscale 同子网 < 1ms,跨公网 30-50ms RTT 时也 < 5ms;**用户感知阈值 ~100ms,差距测不到**
    - 粘贴 1 MB 场景:POST 可走 raw octet-stream 一发,WS 受协议 `bytes_b64` 约束反要 1.33 MB 帧 — **WS 反而更慢**
    - vim 长按方向键 100 keys/s:axum 单核 50k+ req/s,POST 不是瓶颈
  POST 隐性优势:
    - 可观测性(标准 access log / metrics / tracing)
    - 错误处理(标准 status code,WS 上行帧失败语义要自己发明)
    - 重试 / backoff(标准 HTTP 语义)
    - 多客户端冲突时 server 可原子串行化(WS 上行并发要自己加锁)
    - 代码量(reqwest POST 5 行,WS 上行要自己设计 frame schema + 重传 + 顺序保证)
  结论:POST。差距不在性能,在工程复杂度 — POST 简单一个数量级。键盘 < 100/s,粘贴是大头(POST 反而占优)

- **2026-06-09 token 存 keychain 而非 state.json**
  state.json 已有 `bridge_token` 字段(Phase 9.1.2)— 那是给本地 GUI 自己 bridge 用的,与远端 endpoint token 命名空间不同。远端 token 走 keychain 标准位置,跨进程 / 跨用户不泄露;keychain 不可用降级到 state.json 加 chmod 600 + UI 警告

- **2026-06-09 远端 backend 列表运行时拉,不写死配置**
  问题:`config.toml` 是否要枚举每个 endpoint 的 backend 列表
  否决:server 那边 backend 增删配置改 → 客户端不知道。每次连接 `GET /api/v1/backends` 拉一次,缓存 60s
  附带:本地 backend 仍在 `[backends.*]`(Local 模式没有"远端 server" 来问),命名空间不同不冲突

## 给接手的人

### 必读
1. [`roadmap.md`](./roadmap.md) Phase 8 / 9 / 10 主页 — 理解协议层投资
2. [`.specops/specs/remote-protocol.md`](./remote-protocol.md) — 协议契约真源
3. [`docs/protocol-smoke.sh`](../protocol-smoke.sh) — 跨实现等价性测试,改协议必跑
4. [`apps/gui/src-tauri/src/bridge/`](../../apps/gui/src-tauri/src/bridge/) — Rust bridge 参考实现
5. [`services/kode-server-go/`](../../services/kode-server-go/) — Go server 参考实现

### 关键复用点
- `kode_core::pty::PtyHost` + `kode_core::session::*` — Local 路径不动
- `apps/gui/src-tauri/src/bridge/events.rs::BridgeBus` — Remote 字节流灌进同一个 bus,前端不感知来源
- Phase 9.2 Flutter `lib/src/api/api_client.dart` — Remote WS 客户端的设计参考(Dart → Rust 改写,模式一致)
- `keyring` crate — token 存储,跨平台
- Phase 9.1.7 `tests/bridge_e2e.rs` 模式 — 11.3.6 测试参考

### 别动的关键约束
1. **本地 PTY 不进 protocol 字节通道** — 性能 / 语义双重要求
2. **协议变更必须双实现 + smoke** — Rust bridge 与 Go server 不能漂移
3. **远端 codebuddy MCP 配置 kode 不管** — Phase 10 M4.1 banner 只对本地 backend
4. **token 不日志** — `tracing::field::Empty` 占位,任何 log!() 见 token 直接 reject(可加 clippy lint 或 review checklist)
