import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../glass.dart';

class WorkersScreen extends ConsumerStatefulWidget {
  const WorkersScreen({super.key});

  @override
  ConsumerState<WorkersScreen> createState() => _WorkersScreenState();
}

class _WorkersScreenState extends ConsumerState<WorkersScreen> {
  String? _switchingId;
  String? _error;

  Future<void> _activate(WorkerDto worker) async {
    if (_switchingId != null || !worker.online) return;
    final endpoint = ref.read(endpointProvider);
    if (endpoint == null || endpoint.activeWorkerId == worker.workerId) return;
    setState(() {
      _switchingId = worker.workerId;
      _error = null;
    });
    try {
      final updated = endpoint.copyWith(
        workerId: worker.workerId,
        workerName: worker.name,
      );
      await ref.read(endpointStorageProvider).save(updated);
      ref.read(savedEndpointsProvider.notifier).state = [
        ...ref
            .read(savedEndpointsProvider)
            .where((item) => item.storageKey != updated.storageKey),
        updated,
      ];
      ref.read(endpointProvider.notifier).state = updated;
      if (mounted) context.go('/sessions');
    } catch (error) {
      if (mounted) {
        setState(() => _error = 'Could not switch Worker. $error');
      }
    } finally {
      if (mounted) setState(() => _switchingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final workers = ref.watch(workersProvider);
    final endpoint = ref.watch(endpointProvider);
    final activeId = endpoint?.activeWorkerId;
    final colors = Theme.of(context).colorScheme;

    return GlassScaffold(
      appBar: GlassAppBar(
        title: const Text('Workers'),
        actions: [
          IconButton(
            tooltip: 'Refresh Workers',
            onPressed: () => ref.invalidate(workersProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (_error != null)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
                decoration: BoxDecoration(
                  color: colors.errorContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  _error!,
                  style: TextStyle(color: colors.onErrorContainer),
                ),
              ),
            Expanded(
              child: workers.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (error, _) => Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      error is ApiException
                          ? '${error.error}: ${error.detail}'
                          : '$error',
                      textAlign: TextAlign.center,
                    ),
                  ),
                ),
                data: (items) => items.isEmpty
                    ? const Center(child: Text('No Workers found'))
                    : ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: items.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 8),
                        itemBuilder: (context, index) {
                          final worker = items[index];
                          final active = worker.workerId == activeId;
                          final busy = worker.workerId == _switchingId;
                          final platform = [
                            worker.os,
                            worker.arch,
                          ].whereType<String>().join(' · ');
                          return GlassSurface(
                            child: ListTile(
                              minVerticalPadding: 12,
                              enabled: worker.online || active,
                              leading: CircleAvatar(
                                backgroundColor: active
                                    ? colors.primary.withValues(alpha: .12)
                                    : colors.onSurface.withValues(alpha: .04),
                                child: Icon(
                                  Icons.dns_rounded,
                                  color: active
                                      ? colors.primary
                                      : colors.onSurfaceVariant,
                                ),
                              ),
                              title: Text(
                                worker.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              subtitle: Text(
                                [
                                  active
                                      ? 'Current'
                                      : worker.online
                                      ? 'Online'
                                      : 'Offline',
                                  if (platform.isNotEmpty) platform,
                                  if (worker.kodeVersion != null)
                                    'Kode ${worker.kodeVersion}',
                                ].join(' · '),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                              trailing: busy
                                  ? const SizedBox.square(
                                      dimension: 22,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : active
                                  ? Icon(
                                      Icons.check_circle_rounded,
                                      color: colors.primary,
                                    )
                                  : worker.online
                                  ? const Icon(Icons.chevron_right_rounded)
                                  : null,
                              selected: active,
                              selectedTileColor: colors.primaryContainer
                                  .withValues(alpha: .22),
                              onTap:
                                  active ||
                                      !worker.online ||
                                      _switchingId != null
                                  ? null
                                  : () => _activate(worker),
                            ),
                          );
                        },
                      ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: GlassSurface(
                radius: 28,
                blur: true,
                floating: true,
                child: SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: TextButton.icon(
                    onPressed: _switchingId == null
                        ? () => context.push('/devices')
                        : null,
                    icon: const Icon(Icons.settings_remote_rounded),
                    label: const Text('Manage devices'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
