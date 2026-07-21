/// kode mobile companion — 入口。
///
/// 路由:
///   /loading   — 启动时短暂显示,等 endpointBootstrapProvider 完成
///   /pair      — 配对屏(无 endpoint)
///   /sessions  — 主屏 session 列表(已配对)
///
/// bootstrap:
///   1. 已存 endpoint(secure storage) → 直接 /sessions
///   2. 桌面平台未存 → DesktopAutoPair 读本机 kode GUI 的 state.json,自动配对
///   3. 都失败 → /pair
import 'package:flutter/material.dart';
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
      final boot = ref.read(endpointBootstrapProvider);
      final ep = ref.read(endpointProvider);
      final loc = state.matchedLocation;
      if (boot.isLoading) {
        return loc == '/loading' ? null : '/loading';
      }
      if (ep == null) return loc == '/pair' ? null : '/pair';
      // 已配对:/loading 或 /pair 跳 /sessions;其它(/sessions, /sessions/:id)放过
      if (loc == '/loading' || loc == '/pair') return '/sessions';
      return null;
    },
    refreshListenable: _RouterRefresh(ref),
    routes: [
      GoRoute(path: '/loading', builder: (_, _) => const _LoadingScreen()),
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

class KodeApp extends ConsumerWidget {
  const KodeApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(endpointBootstrapProvider);
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
