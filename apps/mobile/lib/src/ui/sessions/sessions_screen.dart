/// session 列表屏 — 启动 home。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../theme.dart';

class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(sessionsProvider);
    final endpoint = ref.watch(endpointProvider);
    final wsState = ref.watch(eventStreamProvider);
    // 触发 attention notifier 启动监听 — 不读值这里,_SessionTile 自己 watch
    ref.watch(sessionAttentionProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text('kode · ${endpoint?.host ?? '?'}'.toUpperCase()),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.read(sessionsProvider.notifier).refresh(),
          ),
          IconButton(
            tooltip: 'Unpair',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await ref.read(endpointStorageProvider).clear();
              ref.read(endpointProvider.notifier).state = null;
              if (context.mounted) context.go('/pair');
            },
          ),
        ],
      ),
      body: Column(
        children: [
          _ConnBanner(state: wsState),
          Expanded(
            child: sessions.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorView(
                message: e is ApiException ? e.toString() : '$e',
                onRetry: () => ref.read(sessionsProvider.notifier).refresh(),
              ),
              data: (list) => list.isEmpty
                  ? const _EmptyView()
                  : RefreshIndicator(
                      onRefresh: () =>
                          ref.read(sessionsProvider.notifier).refresh(),
                      child: ListView.separated(
                        itemCount: list.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, i) => _SessionTile(s: list[i]),
                      ),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ConnBanner extends StatelessWidget {
  final AsyncValue<Envelope> state;
  const _ConnBanner({required this.state});

  @override
  Widget build(BuildContext context) {
    // 简化:只在 error 时显条带,其它隐藏
    final err = state.hasError ? '${state.error}' : null;
    if (err == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(8),
      decoration: const BoxDecoration(
        color: Color(0x33FB5607), // busy/橙 alpha 20%
        border: Border(
          bottom: BorderSide(color: KillLaColors.busy, width: 2),
        ),
      ),
      child: Text('WS: $err',
          style: const TextStyle(
              fontSize: 12,
              color: KillLaColors.busy,
              fontWeight: FontWeight.w700)),
    );
  }
}

class _SessionTile extends ConsumerWidget {
  final SessionDto s;
  const _SessionTile({required this.s});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attention = ref.watch(sessionAttentionProvider);
    final kind = attention[s.id]; // 'ask' | 'plan' | null

    final tile = ListTile(
      leading: _StatusDot(status: s.status),
      title: Row(
        children: [
          Expanded(
            child: Text(s.title.isEmpty ? '(untitled)' : s.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                    fontWeight: FontWeight.w700, letterSpacing: 0.2)),
          ),
          if (kind != null) ...[
            const SizedBox(width: 6),
            _AttentionBadge(kind: kind),
          ],
        ],
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Row(
          children: [
            Flexible(
              child: _Chip(text: s.backendKey, color: KillLaColors.accent),
            ),
            const SizedBox(width: 6),
            Flexible(
              child: _Chip(text: s.model, color: KillLaColors.warning),
            ),
            const SizedBox(width: 6),
            if (s.tokens.total > 0)
              Text('${s.tokens.total} tok',
                  style: const TextStyle(
                      fontSize: 11,
                      color: KillLaColors.textMuted,
                      fontFamily: 'Menlo')),
          ],
        ),
      ),
      trailing: Text('#${s.id}',
          style: const TextStyle(
              fontSize: 12,
              color: KillLaColors.textMuted,
              fontFamily: 'Menlo')),
      onTap: () => GoRouter.of(context).push('/sessions/${s.id}'),
    );

    if (kind == null) return tile;

    // 需要用户操作 — 整张卡片用呼吸高亮包一层
    return _AttentionWrap(kind: kind, child: tile);
  }
}

/// 整行呼吸高亮:1.6s 周期、amber/indigo 边 + 微微背景闪烁。
/// 关心 prefers-reduced-motion → Flutter 端用 MediaQuery.disableAnimationsOf 检测,
/// 命中时退化为静态高亮(只保留边框和背景,不动)。
class _AttentionWrap extends StatefulWidget {
  final String kind; // 'ask' | 'plan'
  final Widget child;
  const _AttentionWrap({required this.kind, required this.child});
  @override
  State<_AttentionWrap> createState() => _AttentionWrapState();
}

class _AttentionWrapState extends State<_AttentionWrap>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = KillLaColors.attention(widget.kind);
    final reduce = MediaQuery.disableAnimationsOf(context);
    if (reduce) {
      // 关掉动画但仍保留视觉提示
      return Container(
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.10),
          border: Border(
            left: BorderSide(color: color, width: 4),
          ),
        ),
        child: widget.child,
      );
    }
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (_, child) {
        // _ctrl 0..1 → curved 0..1 → 0.10..0.24 alpha(KLK 风更强烈)
        final t = Curves.easeInOut.transform(_ctrl.value);
        final bgAlpha = 0.10 + 0.14 * t;
        final borderAlpha = 0.55 + 0.45 * t;
        return Container(
          decoration: BoxDecoration(
            color: color.withValues(alpha: bgAlpha),
            border: Border(
              left: BorderSide(
                color: color.withValues(alpha: borderAlpha),
                width: 4,
              ),
            ),
          ),
          child: child,
        );
      },
      child: widget.child,
    );
  }
}

class _AttentionBadge extends StatefulWidget {
  final String kind;
  const _AttentionBadge({required this.kind});
  @override
  State<_AttentionBadge> createState() => _AttentionBadgeState();
}

class _AttentionBadgeState extends State<_AttentionBadge>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = KillLaColors.attention(widget.kind);
    final label = widget.kind == 'plan' ? '!' : '?';
    final reduce = MediaQuery.disableAnimationsOf(context);
    final dot = Container(
      width: 20,
      height: 20,
      alignment: Alignment.center,
      // KLK 风:不要圆,用切角方块(刀片感)
      decoration: BoxDecoration(
        color: color,
        border: Border.all(color: Colors.black, width: 1.5),
      ),
      child: Text(label,
          style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w900)),
    );
    if (reduce) return dot;
    return ScaleTransition(
      scale: Tween(begin: 1.0, end: 1.22)
          .chain(CurveTween(curve: Curves.easeInOut))
          .animate(_ctrl),
      child: dot,
    );
  }
}

class _StatusDot extends StatelessWidget {
  final String status;
  const _StatusDot({required this.status});
  @override
  Widget build(BuildContext context) {
    final c = KillLaColors.statusDot(status);
    // KLK 风:正方块刀片,带黑色描边
    return Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(
        color: c,
        border: Border.all(color: Colors.black, width: 1),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String text;
  final Color color;
  const _Chip({required this.text, required this.color});
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        border: Border.all(color: color.withValues(alpha: 0.55), width: 1),
      ),
      child: Text(
        text.toLowerCase(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontSize: 10,
          color: color,
          fontFamily: 'Menlo',
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // KLK: 大号红色叉刀
            Container(
              width: 80,
              height: 80,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                border: Border.all(color: KillLaColors.accent, width: 3),
              ),
              child: const Text('×',
                  style: TextStyle(
                      fontSize: 56,
                      height: 1,
                      fontWeight: FontWeight.w900,
                      color: KillLaColors.accent)),
            ),
            const SizedBox(height: 16),
            const Text('NO ACTIVE SESSIONS',
                style: TextStyle(
                    color: KillLaColors.textPrimary,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.2)),
            const SizedBox(height: 4),
            const Text('Start one from the desktop GUI; it will show up here.',
                style: TextStyle(
                    fontSize: 12, color: KillLaColors.textMuted)),
          ],
        ),
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorView({required this.message, required this.onRetry});
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline,
                size: 48, color: KillLaColors.danger),
            const SizedBox(height: 8),
            Text(message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: KillLaColors.textSecondary)),
            const SizedBox(height: 12),
            FilledButton(onPressed: onRetry, child: const Text('RETRY')),
          ],
        ),
      ),
    );
  }
}
