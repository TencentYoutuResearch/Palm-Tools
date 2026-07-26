/// kode mobile companion — 入口。
///
/// 路由:
///   /loading   — 启动时短暂显示,等 endpointBootstrapProvider 完成
///   /local-network — iOS 首次联网前的前置说明
///   /pair      — 配对屏(无 endpoint)
///   /sessions  — 主屏 session 列表(已配对)
///
/// bootstrap:
///   1. iOS 首次启动先过本地网络说明闸门
///   2. 已存 endpoint(secure storage) → 直接 /sessions
///   3. 桌面平台未存 → DesktopAutoPair 读本机 kode GUI 的 state.json,自动配对
///   4. 都失败 → /pair
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'src/state/providers.dart';
import 'src/ui/pair/pair_screen.dart';
import 'src/ui/sessions/session_detail_screen.dart';
import 'src/ui/sessions/sessions_screen.dart';
import 'src/ui/theme.dart';

void main() {
  runApp(const ProviderScope(child: KodeApp()));
}

final _routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/loading',
    redirect: (context, state) {
      final gateRequired = ref.read(localNetworkGateRequiredProvider);
      final gate = ref.read(localNetworkGateProvider);
      final loc = state.matchedLocation;
      if (gate.isLoading) {
        return loc == '/loading' ? null : '/loading';
      }
      final gateAccepted = gate.value ?? !gateRequired;
      if (gateRequired && !gateAccepted) {
        return loc == '/local-network' ? null : '/local-network';
      }
      final boot = ref.read(endpointBootstrapProvider);
      final ep = ref.read(endpointProvider);
      if (boot.isLoading) {
        return loc == '/loading' ? null : '/loading';
      }
      if (loc == '/local-network') {
        return ep == null ? '/pair' : '/sessions';
      }
      if (ep == null) return loc == '/pair' ? null : '/pair';
      // 已配对:/loading 或 /pair 跳 /sessions;其它(/sessions, /sessions/:id)放过
      if (loc == '/loading' || loc == '/pair') return '/sessions';
      return null;
    },
    refreshListenable: _RouterRefresh(ref),
    routes: [
      GoRoute(path: '/loading', builder: (_, _) => const _LoadingScreen()),
      GoRoute(
        path: '/local-network',
        builder: (_, _) => const _LocalNetworkIntroScreen(),
      ),
      GoRoute(path: '/pair', builder: (_, _) => const PairScreen()),
      GoRoute(path: '/sessions', builder: (_, _) => const SessionsScreen()),
      GoRoute(
        path: '/sessions/:id',
        builder: (_, state) {
          final id = int.tryParse(state.pathParameters['id'] ?? '') ?? 0;
          return SessionDetailScreen(sessionId: id);
        },
      ),
    ],
  );
});

class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(this.ref) {
    _epSub = ref.listen(endpointProvider, (_, _) => notifyListeners());
    _bootSub = ref.listen(
      endpointBootstrapProvider,
      (_, _) => notifyListeners(),
    );
  }
  final Ref ref;
  late final ProviderSubscription _epSub;
  late final ProviderSubscription _bootSub;

  @override
  void dispose() {
    _epSub.close();
    _bootSub.close();
    super.dispose();
  }
}

class _LoadingScreen extends StatelessWidget {
  const _LoadingScreen();
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text(
              'CONNECTING…',
              style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.5),
            ),
          ],
        ),
      ),
    );
  }
}

class _LocalNetworkIntroScreen extends ConsumerStatefulWidget {
  const _LocalNetworkIntroScreen();

  @override
  ConsumerState<_LocalNetworkIntroScreen> createState() =>
      _LocalNetworkIntroScreenState();
}

class _LocalNetworkIntroScreenState
    extends ConsumerState<_LocalNetworkIntroScreen> {
  static const _channel = MethodChannel('kode/app');
  bool _openingSettings = false;
  bool _preparingNetwork = false;
  String? _networkHint;

  Future<void> _continueToConnect() async {
    if (_preparingNetwork) return;
    setState(() {
      _preparingNetwork = true;
      _networkHint = null;
    });
    try {
      if (Platform.isIOS) {
        final available =
            await _channel.invokeMethod<bool>('prepareNetworkAccess') ?? false;
        if (!available && mounted) {
          setState(() {
            _networkHint =
                'iOS still reports no wireless access. Check Wireless Data and Local Network in Settings if pairing cannot connect.';
          });
        }
      }
      await ref.read(localNetworkGateProvider.notifier).accept();
    } on PlatformException {
      if (mounted) {
        setState(() {
          _networkHint =
              'Could not start network access. Open Settings and enable Wireless Data and Local Network.';
        });
      }
    } finally {
      if (mounted) setState(() => _preparingNetwork = false);
    }
  }

  Future<void> _openSettings() async {
    if (!Platform.isIOS || _openingSettings) return;
    setState(() => _openingSettings = true);
    try {
      await _channel.invokeMethod<void>('openSettings');
    } finally {
      if (mounted) setState(() => _openingSettings = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(localNetworkGateProvider);
    final busy = gate.isLoading || _preparingNetwork;
    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      color: colors.primary.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: colors.primary.withValues(alpha: 0.3),
                      ),
                    ),
                    alignment: Alignment.center,
                    child: Icon(
                      Icons.wifi_tethering,
                      size: 28,
                      color: colors.primary,
                    ),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    'Enable Local Network Access',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Kode needs both Local Network permission and Wireless Data access to reach your desktop bridge, pair automatically, and stream live sessions on this iPhone.',
                    style: TextStyle(
                      fontSize: 15,
                      height: 1.55,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'Tap Continue to make the first network request. iOS may ask whether Kode can use wireless data. Choose WLAN & Cellular, then allow Local Network when that prompt appears.',
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.5,
                      color: colors.onSurfaceVariant.withValues(alpha: 0.78),
                    ),
                  ),
                  if (_networkHint != null) ...[
                    const SizedBox(height: 14),
                    Text(
                      _networkHint!,
                      style: const TextStyle(
                        fontSize: 13,
                        height: 1.45,
                        color: KillLaColors.warning,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                  const SizedBox(height: 28),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: busy ? null : _continueToConnect,
                      child: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Color(0xFF07100B),
                              ),
                            )
                          : const Text('Enable & Continue'),
                    ),
                  ),
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      onPressed: _openingSettings ? null : _openSettings,
                      child: Text(
                        _openingSettings ? 'Opening Settings…' : 'Open Settings',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class KodeApp extends ConsumerWidget {
  const KodeApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gateAccepted = ref.watch(localNetworkGateProvider).valueOrNull;
    if (gateAccepted ?? false) {
      ref.watch(endpointBootstrapProvider);
    }
    final router = ref.watch(_routerProvider);

    return MaterialApp.router(
      title: 'kode',
      // Same green-neutral token family as the Kode desktop GUI.
      themeMode: ThemeMode.system,
      theme: KillLaTheme.light(),
      darkTheme: KillLaTheme.dark(),
      routerConfig: router,
    );
  }
}
