# kode mobile

iOS / Android 伴侣 App,实时观察并轻量操作桌面 GUI 上跑的 codebuddy / claude session。

## 架构对位

```
桌面 GUI(Tauri+Svelte) ── outbound WSS ──► kode-sync-server
                                              ▲
kode-mobile(Flutter)    ─── HTTPS + WSS ──────┘
一次性 QR secret        ─── claim token ─────► flutter_secure_storage
```

按 [PROTOCOL.md v1](../../.specops/specs/remote-protocol.md) 协议通信。

## 快速开始

```bash
# 1. 装依赖
cd apps/mobile && flutter pub get

# 2. 跑测试(协议解析层 9 个测试)
flutter test

# 3. 跑模拟器(需要 Android Studio / Xcode)
flutter run

# 4. 静态分析
flutter analyze
```

## 配对流程

1. 桌面 kode GUI:`Cmd+P` → "Show Pairing QR…"
2. 手机 App 启动 → 自动跳到 `/pair` 屏 → 点 "Open camera" → 扫 QR
3. App 向中心服务兑换一次性 secret,获得 scoped mobile token
   - 走 `GET /api/v1/healthz` + `GET /api/v1/sessions` 双重验证
4. 跳转到 session 列表 → 实时反映桌面 spawn / kill / model 切换

公网入口若由 DevCloud `AIO-Forward` 托管，客户端会先通过 `/healthz`
完成访问 Cookie 握手，并在后续 REST 与 WebSocket 请求中复用该内存 Cookie。
Kode 的配对 secret 和 mobile bearer token 仍分别负责一次性绑定和 API 授权；
AIO Cookie 不会写入 endpoint storage，也不会编码进二维码。

## 已完成(9.2.0-9.2.1)

- 项目脚手架(riverpod + go_router + dio + web_socket_channel + sqflite + secure_storage + flutter_zxing)

> Scanner: `flutter_zxing` (MIT) — ZXing C++ core Apache 2.0, iOS 无专有传递依赖。
> 此前 `mobile_scanner` 在 iOS 拉 `GoogleMLKit/BarcodeScanning`(Google "Copyright" license,非 OSI)。
- 协议层 Dart 数据模型(Envelope / SessionDto / Endpoint URI 解析)
- ApiClient(REST 全套 + JWT login)
- WSClient(自动重连 + 指数退避 + 25s ping)
- EndpointStorage(钥匙串 / Android Keystore)
- 配对屏:扫码 / 手输 / 健康检查 / 自动持久化
- Sessions 列表屏:状态徽章 + backend chip + model chip + token 计数 + WS 实时更新
- Session debug sheet(临时占位,9.2.3 替换为完整对话视图)

## 待做(独立仓接手)

- [ ] **9.2.3 详情屏** — 消息流(对话气泡)+ tool_use 折叠卡 + AskUserQuestion 原生 picker + Plan markdown viewer
- [ ] **9.2.4 输入框** — 文本 → POST `/input`;长按快捷指令
- [ ] **9.2.5 离线缓存** — sqflite 缓存 message / tool_use,WS 重连后走 `/history?from=` 增量
- [ ] **9.2.6 多 endpoint** — 桌面 + 远端共存,手势切换
- [ ] **CI** — `flutter analyze` + `flutter test` GitHub Action
- [x] **iOS/Android 配置** — `Info.plist` Camera 权限文案 ✓、Android `CAMERA` 权限 ✓(scanner 改用 flutter_zxing,避开 GoogleMLKit 闭源依赖)、Android `AndroidManifest.xml` 网络白名单(LAN HTTP 默认 NSAllowsArbitraryLoads)

## 模块结构

```
lib/
├── main.dart                 入口 + go_router 路由
└── src/
    ├── protocol/             Envelope / SessionDto / Endpoint URI 解析
    ├── api/                  REST(dio) + WS(web_socket_channel)+ 自动重连
    ├── storage/              FlutterSecureStorage 包装
    ├── state/                Riverpod providers 共享
    └── ui/
        ├── pair/             配对屏(scan / manual)
        └── sessions/         主屏 list + session debug sheet
```
