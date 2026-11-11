// kode mobile companion — 中心服务绑定、session 列表和会话详情入口。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'src/platform/watch_link.dart';
import 'src/state/providers.dart';
import 'src/ui/login/login_screen.dart';
import 'src/ui/pair/pair_screen.dart';
import 'src/ui/devices/devices_screen.dart';
import 'src/ui/devices/workers_screen.dart';
import 'src/ui/sessions/session_detail_screen.dart';
import 'src/ui/sessions/sessions_screen.dart';
import 'src/ui/sessions/new_session_screen.dart';
import 'src/ui/theme.dart';
import 'src/ui/glass.dart';

void main() {
  runApp(const ProviderScope(child: KodeApp()));
}

final _routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/loading',
    redirect: (context, state) {
      final loc = state.matchedLocation;
      final boot = ref.read(endpointBootstrapProvider);
      final ep = ref.read(endpointProvider);
      if (boot.isLoading) {
        return loc == '/loading' ? null : '/loading';
      }
      if (ep == null) {
        // Unbound phones may pair by QR or sign in; a signed-in phone picks
        // an account desktop on /devices.
        final signedIn = ref.read(accountProvider) != null;
        if (loc == '/pair' || loc == '/login') return null;
        if (loc == '/devices' && signedIn) return null;
        return signedIn ? '/devices' : '/pair';
      }
      if (loc == '/pair' && state.uri.queryParameters['add'] == '1') {
        return null;
      }
      // 已配对:/loading 或 /pair 跳 /sessions;其它(/sessions, /sessions/:id)放过
      if (loc == '/loading' || loc == '/pair') return '/sessions';
      return null;
    },
    refreshListenable: _RouterRefresh(ref),
    routes: [
      GoRoute(path: '/loading', builder: (_, _) => const _LoadingScreen()),
      GoRoute(path: '/pair', builder: (_, _) => const PairScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/devices', builder: (_, _) => const DevicesScreen()),
      GoRoute(path: '/workers', builder: (_, _) => const WorkersScreen()),
      GoRoute(path: '/sessions', builder: (_, _) => const SessionsScreen()),
      GoRoute(
        path: '/sessions/new',
        builder: (_, _) => const NewSessionScreen(),
      ),
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
    _accountSub = ref.listen(accountProvider, (previous, next) {
      if ((previous == null) != (next == null)) notifyListeners();
    });
  }
  final Ref ref;
  late final ProviderSubscription _epSub;
  late final ProviderSubscription _bootSub;
  late final ProviderSubscription _accountSub;

  @override
  void dispose() {
    _epSub.close();
    _bootSub.close();
    _accountSub.close();
    super.dispose();
  }
}

class _LoadingScreen extends StatelessWidget {
  const _LoadingScreen();
  @override
  Widget build(BuildContext context) {
    return GlassScaffold(
      body: const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('Connecting…', style: TextStyle(fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }
}

class KodeApp extends ConsumerStatefulWidget {
  const KodeApp({super.key});

  @override
  ConsumerState<KodeApp> createState() => _KodeAppState();
}

class _KodeAppState extends ConsumerState<KodeApp> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    // Account desktops stream only while this app is visible.
    _lifecycle = AppLifecycleListener(
      onStateChange: (state) {
        final foreground = state == AppLifecycleState.resumed;
        final current = ref.read(appForegroundProvider);
        if (state == AppLifecycleState.inactive || current == foreground) {
          return;
        }
        ref.read(appForegroundProvider.notifier).state = foreground;
        if (foreground) {
          unawaited(ref.read(accountProvider.notifier).ensureFresh());
        }
      },
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(endpointBootstrapProvider);
    ref.watch(watchLinkProvider);
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
