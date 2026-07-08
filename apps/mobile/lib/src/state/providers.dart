/// Riverpod providers — 全 app 共享的 endpoint / api / ws 状态。
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../protocol/protocol.dart';
import '../storage/desktop_auto_pair.dart';
import '../storage/endpoint_storage.dart';

final endpointStorageProvider =
    Provider<EndpointStorage>((ref) => EndpointStorage());

/// 当前激活的 endpoint。null = 未配对,App 路由到 /pair。
final endpointProvider = StateProvider<Endpoint?>((ref) => null);

/// 启动时一次性 bootstrap:
///   1. 优先用 secure storage 里曾经的 endpoint;但**先 probe 一遍** —— 如果不通
///      (端口变了 / token 失效),不要直接拿空白带进 /sessions 屏挂掉
///   2. 已存不通 → 走桌面自动发现(读本机 kode GUI 的 state.json + 候选端口 probe)
///   3. 都没有 / 都失败 → 留空,UI 走 /pair 屏让用户手填
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

  final stored = await storage.load();
  if (stored != null && await probe(stored)) {
    ref.read(endpointProvider.notifier).state = stored;
    return stored;
  }

  // stored 不通(或没有)→ 试桌面自动发现
  final auto = await DesktopAutoPair.tryDiscover();
  if (auto != null) {
    // 关键:storage.save 在 macOS sandbox 关闭后没有 keychain entitlement,
    // flutter_secure_storage 会抛 -34018。此处带 1.5s 超时 + 吞错,
    // 让 endpoint 仍能推给 UI(不持久化但当前会话能用)。
    try {
      await storage.save(auto).timeout(const Duration(milliseconds: 1500));
    } catch (e) {
      // ignore: avoid_print
      print('[bootstrap] save failed (skip persistence): $e');
    }
    ref.read(endpointProvider.notifier).state = auto;
    return auto;
  }

  if (stored != null) {
    await storage.clear();
  }
  return null;
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
        SessionAttentionNotifier.new);

/// session 列表 — 启动时拉一次 /sessions,WS 事件来了增量更新。
final sessionsProvider =
    AsyncNotifierProvider<SessionsNotifier, List<SessionDto>>(
        SessionsNotifier.new);

class SessionsNotifier extends AsyncNotifier<List<SessionDto>> {
  @override
  Future<List<SessionDto>> build() async {
    final api = ref.watch(apiClientProvider);
    if (api == null) return const [];

    // WS 事件来了时增量更新本地缓存
    final wsSub = ref.listen<AsyncValue<Envelope>>(eventStreamProvider, (_, ev) {
      ev.whenData((env) async {
        switch (env.type) {
          case 'session.created':
            try {
              final s = SessionDto.fromJson(env.payload);
              state = AsyncData([
                ...(state.value ?? const []),
                s,
              ]);
            } catch (_) {}
            break;
          case 'session.exited':
            final sid = env.sessionId;
            state = AsyncData((state.value ?? const [])
                .map((s) => s.id == sid
                    ? SessionDto(
                        id: s.id,
                        backendKey: s.backendKey,
                        title: s.title,
                        model: s.model,
                        status: 'exited',
                        cwd: s.cwd,
                        sessionUuid: s.sessionUuid,
                        tokens: s.tokens,
                        contextPct: s.contextPct,
                        costUsd: s.costUsd,
                      )
                    : s)
                .toList(growable: false));
            break;
          case 'meta':
            // 简化:meta 会更新 model/title/tokens,只 patch 不重建
            final sid = env.sessionId;
            state = AsyncData((state.value ?? const []).map((s) {
              if (s.id != sid) return s;
              final p = env.payload;
              return SessionDto(
                id: s.id,
                backendKey: s.backendKey,
                title: (p['title'] as String?) ?? s.title,
                model: (p['model'] as String?) ?? s.model,
                status: s.status,
                cwd: s.cwd,
                sessionUuid: s.sessionUuid,
                tokens: TokensDto(
                  input: (p['input_tokens'] as num?)?.toInt() ?? s.tokens.input,
                  output:
                      (p['output_tokens'] as num?)?.toInt() ?? s.tokens.output,
                  cached:
                      (p['cached_tokens'] as num?)?.toInt() ?? s.tokens.cached,
                  total: (p['tokens'] as num?)?.toInt() ?? s.tokens.total,
                ),
                contextPct:
                    (p['context_pct'] as num?)?.toDouble() ?? s.contextPct,
                costUsd: (p['cost_usd'] as num?)?.toDouble() ?? s.costUsd,
              );
            }).toList(growable: false));
            break;
        }
      });
    });
    ref.onDispose(wsSub.close);

    return await api.listSessions();
  }

  Future<void> refresh() async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      state = const AsyncData([]);
      return;
    }
    state = const AsyncLoading();
    try {
      state = AsyncData(await api.listSessions());
    } catch (e, st) {
      state = AsyncError(e, st);
    }
  }
}
