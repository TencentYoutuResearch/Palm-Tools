// session 列表屏 — 启动 home。
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../glass.dart';
import '../theme.dart';
import 'backend_identity.dart';
import 'session_appearance.dart';

String _pathLeaf(String? path) {
  if (path == null || path.trim().isEmpty) return 'Workspace';
  final normalized = path.replaceAll('\\', '/');
  final parts = normalized.split('/').where((part) => part.isNotEmpty).toList();
  return parts.isEmpty ? normalized : parts.last;
}

String _pathParent(String? path) {
  if (path == null || path.trim().isEmpty) return '';
  final normalized = path.replaceAll('\\', '/');
  final index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  final parent = normalized.substring(0, index);
  final parts = parent.split('/').where((p) => p.isNotEmpty).toList();
  if (parts.length <= 2) return parent;
  return '…/${parts.sublist(parts.length - 2).join('/')}';
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
  final bool showParent;
  final List<SessionDto> sessions;
  const _SessionGroup({
    required this.key,
    required this.leaf,
    required this.parent,
    required this.showParent,
    required this.sessions,
  });
}

class _BotGroup {
  final String botId;
  final String name;
  final String? tagline;
  final SessionDto primary;
  final List<SessionDto> sessions;
  const _BotGroup({
    required this.botId,
    required this.name,
    required this.tagline,
    required this.primary,
    required this.sessions,
  });
}

List<_BotGroup> _buildBotGroups(List<SessionDto> sessions) {
  final buckets = <String, List<SessionDto>>{};
  for (final session in sessions) {
    final botId = session.botId?.trim();
    if (botId == null || botId.isEmpty) continue;
    buckets.putIfAbsent(botId, () => <SessionDto>[]).add(session);
  }
  final groups = buckets.entries.map((entry) {
    final sorted = [...entry.value]..sort((a, b) {
      final aMain = a.botKind == 'main' ? 0 : 1;
      final bMain = b.botKind == 'main' ? 0 : 1;
      if (aMain != bMain) return aMain.compareTo(bMain);
      return b.id.compareTo(a.id);
    });
    final primary = sorted.first;
    return _BotGroup(
      botId: entry.key,
      name: (primary.botName?.trim().isNotEmpty ?? false)
          ? primary.botName!.trim()
          : (primary.title.trim().isNotEmpty ? primary.title.trim() : entry.key),
      tagline: primary.botTagline?.trim(),
      primary: primary,
      sessions: sorted,
    );
  }).toList()
    ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  return groups;
}

List<_SessionGroup> _buildGroups(List<SessionDto> sessions) {
  final buckets = <String, List<SessionDto>>{};
  for (final session in sessions) {
    final key = _groupKey(session.cwd);
    buckets.putIfAbsent(key, () => <SessionDto>[]).add(session);
  }

  final leafCounts = <String, int>{};
  for (final entry in buckets.entries) {
    final leaf = _pathLeaf(entry.value.first.cwd).toLowerCase();
    leafCounts[leaf] = (leafCounts[leaf] ?? 0) + 1;
  }

  final groups = buckets.entries.map((entry) {
    final sorted = [...entry.value]..sort((a, b) => b.id.compareTo(a.id));
    final leaf = _pathLeaf(sorted.first.cwd);
    final parent = _pathParent(sorted.first.cwd);
    return _SessionGroup(
      key: entry.key,
      leaf: leaf,
      parent: parent,
      showParent: (leafCounts[leaf.toLowerCase()] ?? 0) > 1 && parent.isNotEmpty,
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
  bool _groupsInitialized = false;
  bool _searching = false;
  final TextEditingController _searchCtrl = TextEditingController();
  String _query = '';

  late final AppLifecycleListener _lifecycleListener;

  @override
  void initState() {
    super.initState();
    _lifecycleListener = AppLifecycleListener(
      onResume: () => unawaited(
        ref.read(sessionsProvider.notifier).refresh(showLoading: false),
      ),
    );
  }

  @override
  void dispose() {
    _lifecycleListener.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  bool _matchesQuery(SessionDto s) {
    final q = _query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return s.title.toLowerCase().contains(q) ||
        (s.botName?.toLowerCase().contains(q) ?? false) ||
        (s.botTagline?.toLowerCase().contains(q) ?? false) ||
        (s.cwd?.toLowerCase().contains(q) ?? false) ||
        s.model.toLowerCase().contains(q) ||
        s.backendKey.toLowerCase().contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(sessionsProvider);
    final endpoint = ref.watch(endpointProvider);
    final wsState = ref.watch(eventStreamProvider);
    // 触发 attention notifier 启动监听 — 不读值这里,_SessionTile 自己 watch
    ref.watch(sessionAttentionProvider);

    final colors = Theme.of(context).colorScheme;
    final totalCount = sessions.valueOrNull?.length ?? 0;

    return GlassScaffold(
      appBar: GlassAppBar(
        title: InkWell(
          borderRadius: BorderRadius.circular(12),
          // Account relays list the account's desktops; only self-hosted
          // sync servers have Workers (`/api/v1/workers`).
          onTap: () => context.push(
            endpoint?.isRelay ?? false ? '/devices' : '/workers',
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: wsState.hasError
                        ? KillLaColors.busy
                        : KillLaColors.accent,
                  ),
                ),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    endpoint?.activeWorkerName ??
                        endpoint?.deviceName ??
                        'Sessions',
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -0.2,
                    ),
                  ),
                ),
                const SizedBox(width: 2),
                Icon(
                  Icons.keyboard_arrow_down_rounded,
                  size: 18,
                  color: colors.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
        actions: [
          if (totalCount > 3 || _searching)
            IconButton(
              tooltip: _searching ? 'Close search' : 'Search sessions',
              icon: Icon(_searching ? Icons.close_rounded : Icons.search_rounded),
              onPressed: () {
                setState(() {
                  _searching = !_searching;
                  if (!_searching) {
                    _searchCtrl.clear();
                    _query = '';
                  }
                });
              },
            ),
          IconButton(
            tooltip: 'New session',
            icon: const Icon(Icons.add_rounded),
            onPressed: endpoint == null
                ? null
                : () => context.push('/sessions/new'),
          ),
        ],
      ),
      body: Column(
        children: [
          _ConnBanner(state: wsState),
          if (_searching)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: TextField(
                controller: _searchCtrl,
                autofocus: true,
                onChanged: (v) => setState(() => _query = v),
                style: const TextStyle(fontSize: 14),
                decoration: InputDecoration(
                  hintText: 'Search sessions, bots, workspaces…',
                  prefixIcon: const Icon(Icons.search_rounded, size: 18),
                  suffixIcon: _query.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.clear_rounded, size: 16),
                          onPressed: () {
                            _searchCtrl.clear();
                            setState(() => _query = '');
                          },
                        ),
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  filled: true,
                  fillColor: colors.surfaceContainerHighest.withValues(alpha: 0.45),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
          Expanded(
            child: sessions.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorView(
                message: e is ApiException ? e.toString() : '$e',
                onRetry: () => ref.read(sessionsProvider.notifier).refresh(),
              ),
              data: (list) {
                if (list.isEmpty) return const _EmptyView();
                final filtered = list.where(_matchesQuery).toList();
                if (filtered.isEmpty) {
                  return Center(
                    child: Text(
                      'No matching sessions',
                      style: TextStyle(
                        fontSize: 14,
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  );
                }

                final botGroups = _buildBotGroups(filtered);
                final botSessionIds = {
                  for (final b in botGroups)
                    for (final s in b.sessions) s.id,
                };
                final workspaceSessions = filtered
                    .where((s) => !botSessionIds.contains(s.id))
                    .toList();
                final groups = _buildGroups(workspaceSessions);

                if (!_groupsInitialized) {
                  _groupsInitialized = true;
                  _expandedGroups.addAll(groups.map((group) => group.key));
                } else {
                  _expandedGroups.removeWhere(
                    (key) => !groups.any((group) => group.key == key),
                  );
                }

                return RefreshIndicator(
                  onRefresh: () =>
                      ref.read(sessionsProvider.notifier).refresh(),
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                    children: [
                      if (botGroups.isNotEmpty) ...[
                        _SectionLabel(
                          title: '伙伴',
                          count: botGroups.length,
                        ),
                        const SizedBox(height: 8),
                        for (var i = 0; i < botGroups.length; i++) ...[
                          _BotSessionCard(bot: botGroups[i]),
                          if (i != botGroups.length - 1)
                            const SizedBox(height: 8),
                        ],
                        if (groups.isNotEmpty) const SizedBox(height: 20),
                      ],
                      if (groups.isNotEmpty) ...[
                        if (botGroups.isNotEmpty) ...[
                          _SectionLabel(
                            title: '工作区',
                            count: workspaceSessions.length,
                          ),
                          const SizedBox(height: 8),
                        ],
                        for (var i = 0; i < groups.length; i++) ...[
                          _PathGroupCard(
                            group: groups[i],
                            expanded: _expandedGroups.contains(groups[i].key),
                            onToggle: () {
                              setState(() {
                                if (!_expandedGroups.add(groups[i].key)) {
                                  _expandedGroups.remove(groups[i].key);
                                }
                              });
                            },
                          ),
                          if (i != groups.length - 1)
                            const SizedBox(height: 12),
                        ],
                      ],
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String title;
  final int count;
  const _SectionLabel({required this.title, required this.count});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.3,
              color: colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            '$count',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: colors.onSurfaceVariant.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }
}

class _BotSessionCard extends ConsumerWidget {
  final _BotGroup bot;
  const _BotSessionCard({required this.bot});

  void _openSession(BuildContext context, WidgetRef ref, int sessionId) {
    final sessions = ref.read(sessionsProvider.notifier);
    GoRouter.of(context)
        .push('/sessions/$sessionId')
        .whenComplete(() => sessions.refresh(showLoading: false));
  }

  void _showAllSessions(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                child: Text(
                  '${bot.name} · ${bot.sessions.length} sessions',
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: colors.onSurface,
                  ),
                ),
              ),
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: bot.sessions.length,
                  separatorBuilder: (_, _) => Divider(
                    height: 1,
                    color: colors.outlineVariant.withValues(alpha: 0.3),
                  ),
                  itemBuilder: (_, index) {
                    final row = bot.sessions[index];
                    final kindLabel = switch (row.botKind) {
                      'main' => '主会话',
                      'subtask' => '子任务',
                      'adopted' => '归入会话',
                      _ => '会话',
                    };
                    final title = row.title.trim().isNotEmpty
                        ? row.title.trim()
                        : bot.name;
                    return ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 6),
                      leading: SessionStatusAvatar(
                        session: row,
                        backendKey: row.backendKey,
                        working: row.status == 'busy',
                        size: 34,
                      ),
                      title: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      subtitle: Text(
                        '$kindLabel · ${row.model}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                      trailing: const Icon(Icons.chevron_right_rounded, size: 18),
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        _openSession(context, ref, row.id);
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = bot.primary;
    final attention = ref.watch(sessionAttentionProvider);
    final kind = attention[s.id];
    final unreadCount = ref.watch(
      sessionUnreadCountProvider.select((counts) =>
          bot.sessions.fold<int>(0, (sum, r) => sum + (counts[r.id] ?? 0))),
    );
    final colors = Theme.of(context).colorScheme;
    final working = bot.sessions.any((row) => row.status == 'busy');
    final subtitle = (bot.tagline != null && bot.tagline!.isNotEmpty)
        ? bot.tagline!
        : _sessionMetaLine(s);

    final content = ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: GlassSurface(
        radius: 18,
        child: Stack(
          children: [
            Positioned.fill(
              child: SessionBackgroundLayer(session: s, compact: true),
            ),
            InkWell(
              onTap: () => _openSession(context, ref, s.id),
              onLongPress: bot.sessions.length > 1
                  ? () => _showAllSessions(context, ref)
                  : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                child: Row(
                  children: [
                    SessionStatusAvatar(
                      session: s,
                      backendKey: s.backendKey,
                      working: working,
                      size: 42,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  bot.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w600,
                                    color: colors.onSurface,
                                  ),
                                ),
                              ),
                              if (bot.sessions.length > 1) ...[
                                const SizedBox(width: 6),
                                GestureDetector(
                                  behavior: HitTestBehavior.opaque,
                                  onTap: () => _showAllSessions(context, ref),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 7,
                                      vertical: 2,
                                    ),
                                    decoration: BoxDecoration(
                                      color: colors.onSurface.withValues(alpha: 0.10),
                                      borderRadius: BorderRadius.circular(999),
                                    ),
                                    child: Text(
                                      '${bot.sessions.length}',
                                      style: TextStyle(
                                        fontSize: 11,
                                        fontWeight: FontWeight.w600,
                                        color: colors.onSurfaceVariant,
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                              if (kind != null) ...[
                                const SizedBox(width: 8),
                                _AttentionBadge(kind: kind),
                              ],
                              if (unreadCount > 0) ...[
                                const SizedBox(width: 8),
                                _UnreadBadge(count: unreadCount),
                              ],
                            ],
                          ),
                          if (subtitle.isNotEmpty) ...[
                            const SizedBox(height: 3),
                            Text(
                              subtitle,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 12.5,
                                color: colors.onSurfaceVariant,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 18,
                      color: colors.onSurfaceVariant.withValues(alpha: 0.6),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );

    final wrapped =
        kind == null ? content : _AttentionWrap(kind: kind, child: content);
    if (bot.sessions.length > 1) return wrapped;
    return Dismissible(
      key: ValueKey('bot-session-${s.id}'),
      direction: DismissDirection.endToStart,
      confirmDismiss: (_) => _confirmDelete(context, s),
      background: const SizedBox.shrink(),
      secondaryBackground: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: const _DeleteBackground(),
      ),
      onDismissed: (_) => _handleDismissed(context, ref, s),
      child: wrapped,
    );
  }
}

class _ConnBanner extends StatelessWidget {
  final AsyncValue<Envelope> state;
  const _ConnBanner({required this.state});

  @override
  Widget build(BuildContext context) {
    final err = state.hasError ? '${state.error}' : null;
    if (err == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
      decoration: BoxDecoration(
        color: KillLaColors.busy.withValues(alpha: .10),
        border: Border(
          bottom: BorderSide(
            color: KillLaColors.busy.withValues(alpha: .45),
            width: 1,
          ),
        ),
      ),
      child: Text(
        'Reconnecting: $err',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontSize: 12,
          color: KillLaColors.busy,
          fontWeight: FontWeight.w600,
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
    return GlassSurface(
      radius: 18,
      child: Column(
        children: [
          Tooltip(
            message: group.key == '__unset__'
                ? 'No working directory'
                : group.key,
            child: InkWell(
              borderRadius: BorderRadius.vertical(
                top: const Radius.circular(18),
                bottom: Radius.circular(expanded ? 0 : 18),
              ),
              onTap: onToggle,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 11,
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.folder_copy_outlined,
                      size: 16,
                      color: colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              group.leaf,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w600,
                                color: colors.onSurface,
                              ),
                            ),
                          ),
                          if (group.showParent) ...[
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                group.parent,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: 11.5,
                                  color: colors.onSurfaceVariant.withValues(
                                    alpha: 0.72,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '${group.sessions.length}',
                      style: TextStyle(
                        color: colors.onSurfaceVariant.withValues(alpha: 0.75),
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      expanded
                          ? Icons.keyboard_arrow_up_rounded
                          : Icons.keyboard_arrow_down_rounded,
                      size: 18,
                      color: colors.onSurfaceVariant.withValues(alpha: 0.75),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (expanded) ...[
            Divider(
              height: 1,
              thickness: 0.6,
              color: colors.outlineVariant.withValues(alpha: 0.32),
            ),
            for (var i = 0; i < group.sessions.length; i++) ...[
              _SessionTile(s: group.sessions[i]),
              if (i != group.sessions.length - 1)
                Divider(
                  height: 1,
                  thickness: 0.5,
                  indent: 62,
                  endIndent: 14,
                  color: colors.outlineVariant.withValues(alpha: 0.25),
                ),
            ],
          ],
        ],
      ),
    );
  }
}

String _sessionMetaLine(SessionDto s) {
  final parts = <String>[];
  final backendLabel = backendIdentity(s.backendKey).label;
  if (s.botName != null && s.botName!.trim().isNotEmpty) {
    parts.add(s.botName!.trim());
  } else if (backendLabel.isNotEmpty) {
    parts.add(backendLabel);
  }
  final model = s.model.trim();
  if (model.isNotEmpty && model.toLowerCase() != 'auto') {
    parts.add(model);
  }
  if (s.status == 'busy') {
    parts.add('Working');
  }
  return parts.join(' · ');
}

void _handleDismissed(BuildContext context, WidgetRef ref, SessionDto s) {
  final messenger = ScaffoldMessenger.of(context);
  final notifier = ref.read(sessionsProvider.notifier);
  notifier.removeLocal(s.id);
  unawaited(() async {
    try {
      await notifier.delete(s.id);
    } catch (error) {
      // Let the dismissed row leave the tree before inserting it again.
      // Restoring on the same frame reuses the dismissed Dismissible.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        notifier.restore(s);
        messenger.showSnackBar(
          SnackBar(content: Text(_deleteFailure(error))),
        );
      });
    }
  }());
}

class _SessionTile extends ConsumerWidget {
  final SessionDto s;
  const _SessionTile({required this.s});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attention = ref.watch(sessionAttentionProvider);
    final kind = attention[s.id]; // 'ask' | 'plan' | null
    final unreadCount = ref.watch(
      sessionUnreadCountProvider.select((counts) => counts[s.id] ?? 0),
    );
    final colors = Theme.of(context).colorScheme;
    final metaLine = _sessionMetaLine(s);

    final tile = InkWell(
      onTap: () {
        // Revalidate on return: the socket may have missed exits while away.
        final sessions = ref.read(sessionsProvider.notifier);
        GoRouter.of(context)
            .push('/sessions/${s.id}')
            .whenComplete(() => sessions.refresh(showLoading: false));
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SessionStatusAvatar(
              session: s,
              backendKey: s.backendKey,
              working: s.status == 'busy',
              size: 36,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Text(
                          s.title.trim().isEmpty ? 'Untitled session' : s.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 14.5,
                            fontWeight: FontWeight.w600,
                            color: colors.onSurface,
                          ),
                        ),
                      ),
                      if (kind != null) ...[
                        const SizedBox(width: 8),
                        _AttentionBadge(kind: kind),
                      ],
                      if (unreadCount > 0) ...[
                        const SizedBox(width: 8),
                        _UnreadBadge(count: unreadCount),
                      ],
                    ],
                  ),
                  if (metaLine.isNotEmpty) ...[
                    const SizedBox(height: 3),
                    Text(
                      metaLine,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: s.status == 'busy'
                            ? colors.primary
                            : colors.onSurfaceVariant.withValues(alpha: 0.85),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );

    final row = kind == null ? tile : _AttentionWrap(kind: kind, child: tile);
    return Dismissible(
      key: ValueKey('session-${s.id}'),
      direction: DismissDirection.endToStart,
      confirmDismiss: (_) => _confirmDelete(context, s),
      background: const SizedBox.shrink(),
      secondaryBackground: const _DeleteBackground(),
      onDismissed: (_) => _handleDismissed(context, ref, s),
      child: row,
    );
  }
}

Future<bool> _confirmDelete(BuildContext context, SessionDto session) async {
  final title = session.title.trim().isEmpty
      ? 'This session'
      : session.title.trim();
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Delete session?'),
      content: Text(
        '$title will be stopped on the desktop. This cannot be undone.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(dialogContext, true),
          style: FilledButton.styleFrom(
            backgroundColor: Theme.of(dialogContext).colorScheme.error,
            foregroundColor: Theme.of(dialogContext).colorScheme.onError,
          ),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  return confirmed == true;
}

String _deleteFailure(Object error) {
  if (error is ApiException && error.detail.trim().isNotEmpty) {
    return error.detail.trim();
  }
  return 'Could not delete this session.';
}

class _DeleteBackground extends StatelessWidget {
  const _DeleteBackground();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      alignment: Alignment.centerRight,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      color: colors.error,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          Icon(Icons.delete_outline, color: colors.onError),
          const SizedBox(width: 8),
          Text(
            'Delete',
            style: TextStyle(
              color: colors.onError,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final label = count > 99 ? '99+' : '$count';
    final semanticsLabel = count == 1
        ? '1 unread message'
        : '$label unread messages';
    return Semantics(
      label: semanticsLabel,
      child: ExcludeSemantics(
        child: Container(
          height: 20,
          constraints: const BoxConstraints(minWidth: 20),
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 6),
          decoration: BoxDecoration(
            color: colors.primary,
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: colors.onPrimary,
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    );
  }
}

/// 整行柔和呼吸高亮:1.6s 周期,尊重 prefers-reduced-motion。
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
      return Container(
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          border: Border(left: BorderSide(color: color, width: 3)),
        ),
        child: widget.child,
      );
    }
    return AnimatedBuilder(
      animation: _ctrl,
      builder: (_, child) {
        final t = Curves.easeInOut.transform(_ctrl.value);
        final bgAlpha = 0.06 + 0.09 * t;
        final borderAlpha = 0.55 + 0.45 * t;
        return Container(
          decoration: BoxDecoration(
            color: color.withValues(alpha: bgAlpha),
            border: Border(
              left: BorderSide(
                color: color.withValues(alpha: borderAlpha),
                width: 3,
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
      duration: const Duration(milliseconds: 1200),
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
    final label = widget.kind == 'plan' ? 'Plan' : 'Ask';
    final reduce = MediaQuery.disableAnimationsOf(context);
    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 10.5,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
    if (reduce) return pill;
    return FadeTransition(
      opacity: Tween(
        begin: 0.78,
        end: 1.0,
      ).chain(CurveTween(curve: Curves.easeInOut)).animate(_ctrl),
      child: pill,
    );
  }
}

class _EmptyView extends StatelessWidget {
  const _EmptyView();
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: colors.primary.withValues(alpha: 0.10),
                borderRadius: BorderRadius.circular(18),
              ),
              alignment: Alignment.center,
              child: Icon(
                Icons.chat_bubble_outline_rounded,
                size: 26,
                color: colors.primary,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'No active sessions',
              style: TextStyle(
                fontSize: 16,
                color: colors.onSurface,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Start a session on your connected desktop.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: () => context.push('/sessions/new'),
              icon: const Icon(Icons.add_rounded, size: 18),
              label: const Text('New session'),
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
    final colors = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.cloud_off_rounded,
              size: 40,
              color: colors.onSurfaceVariant,
            ),
            const SizedBox(height: 10),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
