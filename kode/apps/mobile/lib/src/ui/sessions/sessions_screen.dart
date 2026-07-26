/// session 列表屏 — 启动 home。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../theme.dart';

String _compactTokens(int value) {
  if (value >= 1000000) {
    return '${(value / 1000000).toStringAsFixed(value >= 10000000 ? 0 : 1)}M';
  }
  if (value >= 1000) {
    return '${(value / 1000).toStringAsFixed(value >= 10000 ? 0 : 1)}k';
  }
  return '$value';
}

String _pathLeaf(String? path) {
  if (path == null || path.trim().isEmpty) return 'workspace unset';
  final normalized = path.replaceAll('\\', '/');
  final parts = normalized.split('/').where((part) => part.isNotEmpty).toList();
  return parts.isEmpty ? normalized : parts.last;
}

String _pathParent(String? path) {
  if (path == null || path.trim().isEmpty) return 'No working directory';
  final normalized = path.replaceAll('\\', '/');
  final index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized;
  return normalized.substring(0, index);
}

String _groupKey(String? path) {
  final raw = path?.trim();
  if (raw == null || raw.isEmpty) return '__unset__';
  return raw.replaceAll('\\', '/');
}

class _SessionGroup {
  final String key;
  final String leaf;
  final String parent;
  final List<SessionDto> sessions;
  const _SessionGroup({
    required this.key,
    required this.leaf,
    required this.parent,
    required this.sessions,
  });
}

List<_SessionGroup> _buildGroups(List<SessionDto> sessions) {
  final buckets = <String, List<SessionDto>>{};
  for (final session in sessions) {
    final key = _groupKey(session.cwd);
    buckets.putIfAbsent(key, () => <SessionDto>[]).add(session);
  }

  final groups = buckets.entries.map((entry) {
    final sorted = [...entry.value]
      ..sort((a, b) => b.id.compareTo(a.id));
    return _SessionGroup(
      key: entry.key,
      leaf: _pathLeaf(sorted.first.cwd),
      parent: _pathParent(sorted.first.cwd),
      sessions: sorted,
    );
  }).toList()
    ..sort((a, b) {
      final cmp = a.leaf.toLowerCase().compareTo(b.leaf.toLowerCase());
      if (cmp != 0) return cmp;
      return a.parent.toLowerCase().compareTo(b.parent.toLowerCase());
    });

  return groups;
}

class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key});

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  final Set<String> _expandedGroups = <String>{};

  @override
  Widget build(BuildContext context) {
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
                      child: Builder(
                        builder: (context) {
                          final groups = _buildGroups(list);
                          if (_expandedGroups.isEmpty) {
                            _expandedGroups.addAll(
                              groups.map((group) => group.key),
                            );
                          } else {
                            _expandedGroups.removeWhere(
                              (key) => !groups.any((group) => group.key == key),
                            );
                          }
                          return ListView.separated(
                            padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
                            itemCount: groups.length,
                            separatorBuilder: (_, index) =>
                                const SizedBox(height: 12),
                            itemBuilder: (_, i) {
                              final group = groups[i];
                              return _PathGroupCard(
                                group: group,
                                expanded: _expandedGroups.contains(group.key),
                                onToggle: () {
                                  setState(() {
                                    if (!_expandedGroups.add(group.key)) {
                                      _expandedGroups.remove(group.key);
                                    }
                                  });
                                },
                              );
                            },
                          );
                        },
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
      decoration: BoxDecoration(
        color: KillLaColors.busy.withValues(alpha: .12),
        border: Border(bottom: BorderSide(color: KillLaColors.busy, width: 2)),
      ),
      child: Text(
        'WS: $err',
        style: const TextStyle(
          fontSize: 12,
          color: KillLaColors.busy,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _PathGroupCard extends StatelessWidget {
  final _SessionGroup group;
  final bool expanded;
  final VoidCallback onToggle;
  const _PathGroupCard({
    required this.group,
    required this.expanded,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: colors.outline),
      ),
      child: Column(
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: onToggle,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(
                      color: colors.primary.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: colors.primary.withValues(alpha: 0.3),
                      ),
                    ),
                    alignment: Alignment.center,
                    child: Icon(
                      Icons.folder_copy_outlined,
                      size: 18,
                      color: colors.primary,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          group.leaf,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w900,
                            color: colors.onSurface,
                            letterSpacing: 0.2,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          group.parent,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11,
                            color: colors.onSurfaceVariant,
                            fontFamily: 'Menlo',
                          ),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            _Chip(
                              text:
                                  '${group.sessions.length} session${group.sessions.length == 1 ? '' : 's'}',
                              color: KillLaColors.busy,
                            ),
                            _Chip(text: 'path', color: KillLaColors.accent),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Icon(
                    expanded ? Icons.expand_less : Icons.expand_more,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (expanded) ...[
            const Divider(height: 1),
            for (var i = 0; i < group.sessions.length; i++) ...[
              _SessionTile(s: group.sessions[i]),
              if (i != group.sessions.length - 1)
                const Divider(height: 1, indent: 14, endIndent: 14),
            ],
          ],
        ],
      ),
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
    final colors = Theme.of(context).colorScheme;

    final tile = InkWell(
      onTap: () => GoRouter.of(context).push('/sessions/${s.id}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: _StatusDot(status: s.status),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Text(
                              s.title.isEmpty ? '(untitled)' : s.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontWeight: FontWeight.w800,
                                letterSpacing: 0.15,
                                color: colors.onSurface,
                              ),
                            ),
                          ),
                          if (kind != null) ...[
                            const SizedBox(width: 8),
                            _AttentionBadge(kind: kind),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        s.sessionUuid ?? s.backendKey,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11,
                          color: colors.onSurfaceVariant,
                          fontFamily: 'Menlo',
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      '#${s.id}',
                      style: TextStyle(
                        fontSize: 11,
                        color: colors.onSurfaceVariant,
                        fontFamily: 'Menlo',
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      s.status.toUpperCase(),
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.9,
                        color: KillLaColors.statusDot(s.status),
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                _Chip(text: s.model, color: KillLaColors.warning),
                if (s.tokens.total > 0)
                  _Chip(
                    text: '${_compactTokens(s.tokens.total)} tok',
                    color: KillLaColors.busy,
                  ),
                if ((s.contextPct ?? 0) > 0)
                  _Chip(
                    text: 'ctx ${s.contextPct!.toStringAsFixed(0)}%',
                    color: (s.contextPct ?? 0) >= 80
                        ? KillLaColors.danger
                        : (s.contextPct ?? 0) >= 50
                            ? KillLaColors.warning
                            : KillLaColors.textSecondary,
                  ),
              ],
            ),
          ],
        ),
      ),
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
          border: Border(left: BorderSide(color: color, width: 4)),
        ),
        child: widget.child,
      );
    }
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (_, child) {
        // Keep attention visible without overpowering the session metadata.
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
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: KillLaColors.borderStrong),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 12,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
    if (reduce) return dot;
    return ScaleTransition(
      scale: Tween(
        begin: 1.0,
        end: 1.22,
      ).chain(CurveTween(curve: Curves.easeInOut)).animate(_ctrl),
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
    return Container(
      width: 12,
      height: 12,
      decoration: BoxDecoration(
        color: c,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: KillLaColors.borderStrong),
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
        borderRadius: BorderRadius.circular(999),
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
            // Destructive action keeps the semantic danger color.
            Container(
              width: 80,
              height: 80,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                border: Border.all(color: KillLaColors.accent, width: 3),
              ),
              child: const Text(
                '×',
                style: TextStyle(
                  fontSize: 56,
                  height: 1,
                  fontWeight: FontWeight.w900,
                  color: KillLaColors.accent,
                ),
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'NO ACTIVE SESSIONS',
              style: TextStyle(
                color: KillLaColors.textPrimary,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.2,
              ),
            ),
            const SizedBox(height: 4),
            const Text(
              'Start one from the desktop GUI; it will show up here.',
              style: TextStyle(fontSize: 12, color: KillLaColors.textMuted),
            ),
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
            const Icon(
              Icons.error_outline,
              size: 48,
              color: KillLaColors.danger,
            ),
            const SizedBox(height: 8),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: KillLaColors.textSecondary),
            ),
            const SizedBox(height: 12),
            FilledButton(onPressed: onRetry, child: const Text('RETRY')),
          ],
        ),
      ),
    );
  }
}
