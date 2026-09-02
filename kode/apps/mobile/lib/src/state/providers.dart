// Riverpod providers — 全 app 共享的 endpoint / api / ws 状态。
import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../protocol/protocol.dart';
import '../storage/endpoint_storage.dart';

final endpointStorageProvider = Provider<EndpointStorage>(
  (ref) => EndpointStorage(),
);

/// 当前激活的 endpoint。null = 未配对,App 路由到 /pair。
final endpointProvider = StateProvider<Endpoint?>((ref) => null);
final savedEndpointsProvider = StateProvider<List<Endpoint>>((ref) => const []);

/// 启动时一次性 bootstrap:
///   1. 优先用 secure storage 里曾经的 endpoint;但**先 probe 一遍** —— 如果不通
///      (端口变了 / token 失效),不要直接拿空白带进 /sessions 屏挂掉
///   2. 已存不通 → 清除失效绑定,UI 走 /pair 重新扫码
final endpointBootstrapProvider = FutureProvider<Endpoint?>((ref) async {
  final storage = ref.read(endpointStorageProvider);

  Future<bool> probe(Endpoint ep) async {
    try {
      final c = ApiClient(ep);
      if (!await c.healthz()) return false;
      await c.listSessions();
      return true;
    } catch (e, st) {
      // ignore: avoid_print
      print('[bootstrap] probe failed: $e\n$st');
      return false;
    }
  }

  final collection = await storage.loadCollection();
  ref.read(savedEndpointsProvider.notifier).state = collection.endpoints;
  if (collection.endpoints.isEmpty) return null;

  final preferred = collection.active ?? collection.endpoints.first;
  final candidates = [
    preferred,
    ...collection.endpoints.where(
      (endpoint) => endpoint.storageKey != preferred.storageKey,
    ),
  ];
  final reachable = await Future.wait(candidates.map(probe));
  for (var index = 0; index < candidates.length; index++) {
    if (!reachable[index]) continue;
    final endpoint = candidates[index];
    await storage.activate(endpoint.storageKey);
    ref.read(endpointProvider.notifier).state = endpoint;
    return endpoint;
  }

  // Keep unreachable bindings available for device management and retry.
  ref.read(endpointProvider.notifier).state = preferred;
  return preferred;
});

/// 当 endpoint 变化时,自动产生匹配的 ApiClient。
final apiClientProvider = Provider<ApiClient?>((ref) {
  final ep = ref.watch(endpointProvider);
  return ep == null ? null : ApiClient(ep);
});

/// WSClient 跟着 endpoint 变化重新创建。
/// dispose 时主动关闭 socket — 避免泄漏 timer。
final wsClientProvider = Provider<WSClient?>((ref) {
  final ep = ref.watch(endpointProvider);
  if (ep == null) return null;
  final ws = WSClient(ep);
  ws.connect();
  ref.onDispose(ws.dispose);
  return ws;
});

/// 把 server 推过来的 envelope 转成 stream(给 UI 订阅)。
final eventStreamProvider = StreamProvider<Envelope>((ref) {
  final ws = ref.watch(wsClientProvider);
  if (ws == null) return const Stream.empty();
  return ws.events;
});

/// "需要用户操作"的 session id 集合。
///
/// 触发:WS 推 ask_user_question / plan_proposed → 加进集合(对应卡片在 _ingest 里
/// 已经塞到详情屏的消息流里;这里只负责"是否在 session list / 详情屏的 AppBar 上闪烁")。
///
/// 清除:**只**在 server 推 `session.attention_cleared`(prompt 真的从 PTY 屏幕消失,
/// 也就是用户已经回应过)时清掉。**用户单纯打开 session 详情屏不会清** — 否则用户
/// 切过去看一眼就误认为已处理,实际还卡着等回应。这是有意的设计。
class SessionAttentionNotifier extends Notifier<Map<int, String>> {
  @override
  Map<int, String> build() {
    ref.listen(endpointProvider, (_, _) => state = const {});
    // 监听 ws 事件,自动更新
    ref.listen<AsyncValue<Envelope>>(eventStreamProvider, (_, ev) {
      ev.whenData((env) {
        switch (env.type) {
          case 'ask_user_question':
            state = {...state, env.sessionId: 'ask'};
            break;
          case 'plan_proposed':
            state = {...state, env.sessionId: 'plan'};
            break;
          case 'session.attention_cleared':
            // server 检测到 prompt 已解除 → 清掉对应 session 的 attention
            if (state.containsKey(env.sessionId)) {
              final next = Map<int, String>.from(state)..remove(env.sessionId);
              state = next;
            }
            break;
        }
      });
    });
    return const {};
  }

  /// **谨慎用**:仅用户已确实回答完(例如点 Submit 后 server 短暂还没 emit clear,
  /// 前端先乐观清掉)时调用。普通的"打开详情屏"不应调用 — 让 server 的
  /// session.attention_cleared 事件来主导。
  void clearOptimistic(int sessionId) {
    if (!state.containsKey(sessionId)) return;
    final next = Map<int, String>.from(state)..remove(sessionId);
    state = next;
  }
}

final sessionAttentionProvider =
    NotifierProvider<SessionAttentionNotifier, Map<int, String>>(
      SessionAttentionNotifier.new,
    );

/// 每个 session 的未读助手消息数。
///
/// 只统计非 user 的 message 事件，避免用户自己发出的消息在回流后被误标未读。
/// 正在查看的 session 不累计；进入详情时清零。内部最多保留 100，UI 将其显示为 99+。
class SessionUnreadCountNotifier extends Notifier<Map<int, int>> {
  int? _viewedSessionId;

  @override
  Map<int, int> build() {
    ref.listen(endpointProvider, (_, _) {
      _viewedSessionId = null;
      state = const {};
    });
    ref.listen<AsyncValue<Envelope>>(eventStreamProvider, (_, event) {
      event.whenData((envelope) {
        if (envelope.type == 'session.exited') {
          _remove(envelope.sessionId);
          return;
        }
        if (envelope.type != 'message' ||
            envelope.payload['role'] == 'user' ||
            envelope.sessionId == _viewedSessionId) {
          return;
        }
        final current = state[envelope.sessionId] ?? 0;
        state = {
          ...state,
          envelope.sessionId: current >= 99 ? 100 : current + 1,
        };
      });
    });
    return const {};
  }

  void viewSession(int sessionId) {
    _viewedSessionId = sessionId;
    _remove(sessionId);
  }

  void leaveSession(int sessionId) {
    if (_viewedSessionId == sessionId) _viewedSessionId = null;
  }

  void _remove(int sessionId) {
    if (!state.containsKey(sessionId)) return;
    state = Map<int, int>.unmodifiable(
      Map<int, int>.from(state)..remove(sessionId),
    );
  }
}

final sessionUnreadCountProvider =
    NotifierProvider<SessionUnreadCountNotifier, Map<int, int>>(
      SessionUnreadCountNotifier.new,
    );

/// session 列表 — 启动时拉一次 /sessions,WS 事件来了增量更新。
final sessionsProvider =
    AsyncNotifierProvider<SessionsNotifier, List<SessionDto>>(
      SessionsNotifier.new,
    );

/// Merge one authoritative full session snapshot without duplicating rows.
/// `session.created` and `session.updated` intentionally share this reducer.
List<SessionDto> mergeSessionSnapshot(
  List<SessionDto> current,
  SessionDto incoming,
) {
  if (incoming.status == 'exited') {
    return current
        .where((session) => session.id != incoming.id)
        .toList(growable: false);
  }
  var replaced = false;
  final merged = current
      .map((session) {
        if (session.id != incoming.id) return session;
        replaced = true;
        return incoming;
      })
      .toList(growable: true);
  if (!replaced) merged.add(incoming);
  return merged;
}

class SessionsNotifier extends AsyncNotifier<List<SessionDto>> {
  int _refreshGeneration = 0;

  @override
  Future<List<SessionDto>> build() async {
    final api = ref.watch(apiClientProvider);
    if (api == null) return const [];

    // WS 事件来了时增量更新本地缓存
    final wsSub = ref.listen<AsyncValue<Envelope>>(eventStreamProvider, (
      _,
      ev,
    ) {
      ev.whenData((env) async {
        switch (env.type) {
          case 'session.created':
          case 'session.updated':
            try {
              final s = SessionDto.fromJson(env.payload);
              state = AsyncData(
                mergeSessionSnapshot(state.value ?? const [], s),
              );
            } catch (_) {}
            break;
          case 'connection.hello':
            // The WS stream is incremental and can miss metadata while iOS is
            // suspended. Every fresh/reconnected socket revalidates the full
            // authoritative list while keeping stale content visible.
            await refresh(showLoading: false);
            break;
          case 'session.exited':
            final sid = env.sessionId;
            state = AsyncData(
              (state.value ?? const [])
                  .where((session) => session.id != sid)
                  .toList(growable: false),
            );
            break;
          case 'session.status':
            final sid = env.sessionId;
            final status = env.payload['status'] as String?;
            if (status == null) break;
            state = AsyncData(
              (state.value ?? const [])
                  .map(
                    (session) => session.id == sid
                        ? session.copyWith(status: status)
                        : session,
                  )
                  .where((session) => session.status != 'exited')
                  .toList(growable: false),
            );
            break;
          case 'meta':
            // 简化:meta 会更新 model/title/tokens,只 patch 不重建
            final sid = env.sessionId;
            state = AsyncData(
              (state.value ?? const [])
                  .map((s) {
                    if (s.id != sid) return s;
                    final p = env.payload;
                    return s.copyWith(
                      title: (p['title'] as String?) ?? s.title,
                      model: (p['model'] as String?) ?? s.model,
                      tokens: TokensDto(
                        input:
                            (p['input_tokens'] as num?)?.toInt() ??
                            s.tokens.input,
                        output:
                            (p['output_tokens'] as num?)?.toInt() ??
                            s.tokens.output,
                        cached:
                            (p['cached_tokens'] as num?)?.toInt() ??
                            s.tokens.cached,
                        total: (p['tokens'] as num?)?.toInt() ?? s.tokens.total,
                      ),
                      contextPct: (p['context_pct'] as num?)?.toDouble(),
                      costUsd: (p['cost_usd'] as num?)?.toDouble(),
                    );
                  })
                  .toList(growable: false),
            );
            break;
        }
      });
    });
    ref.onDispose(wsSub.close);

    return await api.listSessions();
  }

  Future<void> refresh({bool showLoading = true}) async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      state = const AsyncData([]);
      return;
    }
    final generation = ++_refreshGeneration;
    final previous = state.valueOrNull;
    if (showLoading || previous == null) state = const AsyncLoading();
    try {
      final sessions = await api.listSessions();
      if (generation == _refreshGeneration) state = AsyncData(sessions);
    } catch (e, st) {
      if (generation != _refreshGeneration) return;
      if (showLoading || previous == null) {
        state = AsyncError(e, st);
      }
    }
  }
}

enum SessionMessageQueueStatus { submitting, queued, sent, processed, failed }

/// Mirrors `kode-bridge::semantic::fnv_hash` so an optimistic mobile message
/// owns the same semantic id as the later CLI transcript event.
String sessionSemanticMessageId(int sessionId, String text) {
  var hash = 0x811c9dc5;
  for (final byte in utf8.encode(text.trim())) {
    hash = ((hash ^ byte) * 0x01000193) & 0xffffffff;
  }
  return '$sessionId-$hash';
}

/// One outbound composer submission and its cloud command acknowledgement.
class QueuedSessionMessage {
  final String id;
  final String semanticMessageId;
  final String text;
  final DateTime queuedAt;
  final SessionMessageQueueStatus status;
  final String? commandId;
  final String? error;

  const QueuedSessionMessage({
    required this.id,
    required this.semanticMessageId,
    required this.text,
    required this.queuedAt,
    this.status = SessionMessageQueueStatus.submitting,
    this.commandId,
    this.error,
  });

  QueuedSessionMessage copyWith({
    SessionMessageQueueStatus? status,
    String? commandId,
    String? error,
    bool clearCommandId = false,
    bool clearError = false,
  }) => QueuedSessionMessage(
    id: id,
    semanticMessageId: semanticMessageId,
    text: text,
    queuedAt: queuedAt,
    status: status ?? this.status,
    commandId: clearCommandId ? null : commandId ?? this.commandId,
    error: clearError ? null : error ?? this.error,
  );
}

/// Tracks the actual server/desktop command lifecycle for mobile messages.
///
/// `POST /input` always happens immediately, even while the session is busy.
/// A 202 response means the cloud server queued/dispatched the command; only
/// `command.status=executed` confirms that the desktop wrote it to the PTY.
class SessionMessageQueueNotifier
    extends Notifier<Map<int, List<QueuedSessionMessage>>> {
  final Map<String, ({String status, String? error})> _earlyStatuses = {};
  int _sequence = 0;

  @override
  Map<int, List<QueuedSessionMessage>> build() {
    ref.listen(endpointProvider, (_, _) {
      _earlyStatuses.clear();
      state = const {};
    });
    ref.listen<AsyncValue<Envelope>>(eventStreamProvider, (_, event) {
      event.whenData((envelope) {
        if (envelope.type == 'message' && envelope.payload['role'] == 'user') {
          final semanticId = envelope.payload['id'] as String?;
          final text = envelope.payload['text'] as String?;
          if (semanticId != null || text != null) {
            markProcessed(
              envelope.sessionId,
              semanticMessageId: semanticId,
              text: text,
            );
          }
          return;
        }
        if (envelope.type != 'command.status') return;
        final commandId = envelope.payload['command_id'] as String?;
        final status = envelope.payload['status'] as String?;
        if (commandId == null || status == null) return;
        final error = envelope.payload['error'] as String?;
        if (!_applyCommandStatus(
          envelope.sessionId,
          commandId,
          status,
          error,
        )) {
          // The WebSocket can outrun the HTTP 202 response that reveals the
          // command id. Keep the newest receipt and reconcile after POST.
          _earlyStatuses[commandId] = (status: status, error: error);
        }
      });
    });
    return const {};
  }

  QueuedSessionMessage? enqueue({
    required int sessionId,
    required String text,
  }) {
    final normalized = text.trim();
    if (normalized.isEmpty) return null;
    final entry = QueuedSessionMessage(
      id: '${DateTime.now().microsecondsSinceEpoch}-${_sequence++}',
      semanticMessageId: sessionSemanticMessageId(sessionId, normalized),
      text: normalized,
      queuedAt: DateTime.now(),
    );
    _replace(sessionId, [...(state[sessionId] ?? const []), entry]);
    unawaited(_submit(sessionId, entry.id));
    return entry;
  }

  void remove(int sessionId, String messageId) {
    final messages = state[sessionId] ?? const [];
    final target = messages.where((item) => item.id == messageId).firstOrNull;
    if (target?.status == SessionMessageQueueStatus.submitting) return;
    _replace(
      sessionId,
      messages.where((item) => item.id != messageId).toList(growable: false),
    );
  }

  void retry(int sessionId, String messageId) {
    final messages = state[sessionId] ?? const [];
    _replace(
      sessionId,
      messages
          .map(
            (item) => item.id == messageId
                ? item.copyWith(
                    status: SessionMessageQueueStatus.submitting,
                    clearCommandId: true,
                    clearError: true,
                  )
                : item,
          )
          .toList(growable: false),
    );
    unawaited(_submit(sessionId, messageId));
  }

  Future<void> _submit(int sessionId, String messageId) async {
    final messages = state[sessionId] ?? const [];
    final message = messages.where((item) => item.id == messageId).firstOrNull;
    if (message == null) return;
    try {
      final api = ref.read(apiClientProvider);
      if (api == null) throw StateError('Desktop connection unavailable');
      var payload = message.text
          .replaceAll('\r\n', '\n')
          .replaceAll('\r', '\n');
      if (!payload.endsWith('\n')) payload = '$payload\n';
      final receipt = await api.sendInputText(sessionId, payload);
      final nextStatus = receipt.isConfirmed
          ? SessionMessageQueueStatus.sent
          : SessionMessageQueueStatus.queued;
      _update(
        sessionId,
        messageId,
        (item) => item.status == SessionMessageQueueStatus.processed
            ? item
            : item.copyWith(
                status: nextStatus,
                commandId: receipt.commandId,
                clearError: true,
              ),
      );
      if (receipt.commandId case final commandId?) {
        final early = _earlyStatuses.remove(commandId);
        if (early != null) {
          _applyCommandStatus(sessionId, commandId, early.status, early.error);
        }
      }
    } catch (error) {
      _update(
        sessionId,
        messageId,
        (item) => item.status == SessionMessageQueueStatus.processed
            ? item
            : item.copyWith(
                status: SessionMessageQueueStatus.failed,
                error: error.toString(),
              ),
      );
    }
  }

  bool _applyCommandStatus(
    int sessionId,
    String commandId,
    String status,
    String? error,
  ) {
    final messages = state[sessionId] ?? const [];
    final message = messages
        .where((item) => item.commandId == commandId)
        .firstOrNull;
    if (message == null) return false;
    if (message.status == SessionMessageQueueStatus.processed) return true;
    switch (status) {
      case 'dispatched':
      case 'accepted':
        _update(
          sessionId,
          message.id,
          (item) => item.copyWith(
            status: SessionMessageQueueStatus.queued,
            clearError: true,
          ),
        );
        break;
      case 'executed':
        _update(
          sessionId,
          message.id,
          (item) => item.copyWith(
            status: SessionMessageQueueStatus.sent,
            clearError: true,
          ),
        );
        break;
      case 'failed':
      case 'expired':
        _update(
          sessionId,
          message.id,
          (item) => item.copyWith(
            status: SessionMessageQueueStatus.failed,
            error: error ?? 'Desktop did not accept the message',
          ),
        );
        break;
    }
    return true;
  }

  void markProcessed(int sessionId, {String? semanticMessageId, String? text}) {
    final messages = state[sessionId] ?? const [];
    final normalizedText = text?.trim();
    final message = messages.where((item) {
      if (item.status == SessionMessageQueueStatus.processed) return false;
      if (semanticMessageId != null &&
          item.semanticMessageId == semanticMessageId) {
        return true;
      }
      return normalizedText != null && item.text.trim() == normalizedText;
    }).firstOrNull;
    if (message == null) return;
    _update(
      sessionId,
      message.id,
      (item) => item.copyWith(
        status: SessionMessageQueueStatus.processed,
        clearError: true,
      ),
    );
  }

  void _update(
    int sessionId,
    String messageId,
    QueuedSessionMessage Function(QueuedSessionMessage) update,
  ) {
    final messages = state[sessionId] ?? const [];
    _replace(
      sessionId,
      messages
          .map((item) => item.id == messageId ? update(item) : item)
          .toList(growable: false),
    );
  }

  void _replace(int sessionId, List<QueuedSessionMessage> messages) {
    var processedToDrop = messages.length - 100;
    final retained = processedToDrop > 0
        ? messages
              .where((message) {
                if (processedToDrop > 0 &&
                    message.status == SessionMessageQueueStatus.processed) {
                  processedToDrop--;
                  return false;
                }
                return true;
              })
              .toList(growable: false)
        : messages;
    final next = Map<int, List<QueuedSessionMessage>>.from(state);
    if (retained.isEmpty) {
      next.remove(sessionId);
    } else {
      next[sessionId] = List.unmodifiable(retained);
    }
    state = Map.unmodifiable(next);
  }
}

final sessionMessageQueueProvider =
    NotifierProvider<
      SessionMessageQueueNotifier,
      Map<int, List<QueuedSessionMessage>>
    >(SessionMessageQueueNotifier.new);
