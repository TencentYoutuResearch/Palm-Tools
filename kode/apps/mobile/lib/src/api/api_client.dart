/// REST + WS 客户端 —— 严格按 PROTOCOL.md v1 实现。
///
/// 设计:
/// - 一个 Endpoint 对应一个 ApiClient + 一个 WSClient(独立 channel,客户端
///   可同时连多个 server,虽然 v0.1 UI 只暴露一个)
/// - REST 错误 → 抛 ApiException
/// - WS 断线由调用方决定重连策略(配 Riverpod ref + 协议 §4.4 增量补全)
library;

import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/protocol.dart';

class ApiException implements Exception {
  final int status;
  final String error;
  final String detail;
  ApiException(this.status, this.error, this.detail);
  @override
  String toString() => 'ApiException($status, $error: $detail)';
}

class ApiClient {
  final Endpoint endpoint;
  final Dio _dio;

  ApiClient(this.endpoint)
    : _dio = Dio(
        BaseOptions(
          baseUrl: endpoint.baseUrl,
          headers: {
            'Authorization': 'Bearer ${endpoint.token}',
            'Content-Type': 'application/json',
          },
          connectTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 15),
          // 让我们自己处理状态码,而不是 dio 默认的"非 2xx 就 throw"
          validateStatus: (_) => true,
        ),
      );

  Future<bool> healthz() async {
    final resp = await _dio.getUri<String>(
      Uri.parse('${endpoint.baseUrl}/healthz'),
      options: Options(headers: const {}, responseType: ResponseType.plain),
    );
    return resp.statusCode == 200 && (resp.data?.trim() == 'ok');
  }

  Future<List<SessionDto>> listSessions() async {
    final resp = await _dio.get('/api/v1/sessions');
    _check(resp);
    final list = (resp.data['sessions'] as List?) ?? const [];
    return list
        .map((e) => SessionDto.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  Future<SessionDto> getSession(int id) async {
    final resp = await _dio.get('/api/v1/sessions/$id');
    _check(resp);
    return SessionDto.fromJson(resp.data as Map<String, dynamic>);
  }

  Future<SessionDto> createSession({
    required String backendKey,
    String? cwd,
    String? resumeSessionUuid,
  }) async {
    final resp = await _dio.post(
      '/api/v1/sessions',
      data: {
        'backend_key': backendKey,
        if (cwd != null) 'cwd': cwd,
        if (resumeSessionUuid != null) 'resume_session_uuid': resumeSessionUuid,
      },
    );
    _check(resp);
    return SessionDto.fromJson(resp.data as Map<String, dynamic>);
  }

  Future<void> deleteSession(int id) async {
    final resp = await _dio.delete('/api/v1/sessions/$id');
    _check(resp);
  }

  Future<void> sendInputText(int id, String text) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/input',
      data: {'text': text},
    );
    _check(resp);
  }

  Future<List<Envelope>> getHistory(int id, {int? fromMs, int? limit}) async {
    final qp = <String, dynamic>{};
    if (fromMs != null) qp['from'] = fromMs;
    if (limit != null) qp['limit'] = limit;
    final resp = await _dio.get(
      '/api/v1/sessions/$id/history',
      queryParameters: qp.isEmpty ? null : qp,
    );
    _check(resp);
    final list = (resp.data['events'] as List?) ?? const [];
    return list
        .map((e) => Envelope.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
  }

  /// 协议 §4.6 — 回答 AskUserQuestion。
  /// **当前 Rust bridge 占位 500**。
  /// 真实 PTY 编码尚未确定 → 这个方法会因 server 返 500 而抛 ApiException。
  /// Flutter 显示给用户即可,等 server 端实装后自动 work。
  Future<void> postAnswer(
    int id,
    String questionId,
    int choiceIndex, {
    String? freeText,
    bool submit = false,
  }) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/answer',
      data: {
        'question_id': questionId,
        'choice_index': choiceIndex,
        if (freeText != null) 'free_text': freeText,
        if (submit) 'submit': true,
      },
    );
    _check(resp);
  }

  /// 协议 §4.7 — 回应 ExitPlanMode 提议(Accept/Reject)。
  /// 同样:server 端 500 占位中。
  Future<void> postPlanResponse(int id, String planId, bool accept) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/plan_response',
      data: {'plan_id': planId, 'accept': accept},
    );
    _check(resp);
  }

  /// 切换 codebuddy/claude 的 PermissionMode。
  /// mode ∈ {default, acceptEdits, bypassPermissions, plan}。
  /// bridge 通过发 Shift+Tab(`\x1b[Z`)字节给 PTY 触发 cycle,直到屏幕识别到目标 mode。
  /// 返回 server 实际到达的 mode(理论上跟入参一致;cycle 失败会抛 500)。
  Future<String> setMode(int id, String mode) async {
    final resp = await _dio.post(
      '/api/v1/sessions/$id/mode',
      data: {'mode': mode},
    );
    _check(resp);
    return resp.data['mode'] as String;
  }

  /// 创建 session。permission_mode 可选,会被 bridge 注入 `--permission-mode <m>`。
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

  /// 用户名密码换 JWT。Rust bridge 不实现 /login,此方法保留给未来 auth 扩展。
  Future<String> login(String username, String password) async {
    final resp = await _dio.post(
      '/api/v1/auth/login',
      // /login 不该带 bearer
      options: Options(headers: const {'Content-Type': 'application/json'}),
      data: {'username': username, 'password': password},
    );
    _check(resp);
    return resp.data['token'] as String;
  }

  void _check(Response resp) {
    final code = resp.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      String name = 'http_$code';
      String detail = '';
      if (resp.data is Map<String, dynamic>) {
        name = resp.data['error'] as String? ?? name;
        detail = resp.data['detail'] as String? ?? '';
      }
      final err = ApiException(code, name, detail);
      // ignore: avoid_print
      print(
        '[api] ${resp.requestOptions.method} ${resp.requestOptions.path} -> $err',
      );
      throw err;
    }
  }
}

/// WebSocket 客户端 —— 单向接事件。
///
/// 协议 §5.2:WS 是只读的;手机端写入用 REST。本类只暴露 onEvent stream,
/// 不支持发自定义消息(除了协议允许的可选 ping)。
class WSClient {
  final Endpoint endpoint;
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  final _events = StreamController<Envelope>.broadcast();
  final _connState = StreamController<WSConnState>.broadcast();
  Timer? _reconnectTimer;
  Timer? _pingTimer;
  bool _disposed = false;
  Duration _backoff = const Duration(seconds: 1);

  WSClient(this.endpoint);

  Stream<Envelope> get events => _events.stream;
  Stream<WSConnState> get connState => _connState.stream;

  void connect() {
    if (_disposed) return;
    _connState.add(WSConnState.connecting);
    try {
      _channel = WebSocketChannel.connect(Uri.parse(endpoint.wsUrl));
    } catch (e) {
      // ignore: avoid_print
      print('[ws] connect failed: $e');
      _scheduleReconnect();
      return;
    }
    _sub = _channel!.stream.listen(
      (raw) {
        if (raw is String) {
          try {
            final j = jsonDecode(raw) as Map<String, dynamic>;
            // ping/pong 心跳:type:pong 自己消化,不抛
            if (j['type'] == 'pong') return;
            _events.add(Envelope.fromJson(j));
            _connState.add(WSConnState.connected);
            _backoff = const Duration(seconds: 1); // 健康收包就重置 backoff
          } catch (e) {
            // 不抛,只 log
            // ignore: avoid_print
            print(
              '[ws] bad frame: $e -- ${raw.substring(0, raw.length.clamp(0, 200))}',
            );
          }
        }
      },
      onError: (e) {
        // ignore: avoid_print
        print('[ws] error: $e');
        _connState.add(WSConnState.disconnected);
        _scheduleReconnect();
      },
      onDone: () {
        _connState.add(WSConnState.disconnected);
        _scheduleReconnect();
      },
      cancelOnError: true,
    );
    _startPingTimer();
  }

  void _startPingTimer() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      try {
        _channel?.sink.add('{"type":"ping"}');
      } catch (_) {}
    });
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _pingTimer?.cancel();
    _sub?.cancel();
    _sub = null;
    _reconnectTimer?.cancel();
    final delay = _backoff;
    _backoff = Duration(
      milliseconds: (_backoff.inMilliseconds * 2).clamp(1000, 30000),
    );
    _reconnectTimer = Timer(delay, connect);
  }

  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _pingTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _events.close();
    _connState.close();
  }
}

enum WSConnState { connecting, connected, disconnected }
