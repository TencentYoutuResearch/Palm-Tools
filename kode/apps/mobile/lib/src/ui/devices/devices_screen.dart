import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';

class DevicesScreen extends ConsumerStatefulWidget {
  const DevicesScreen({super.key});

  @override
  ConsumerState<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends ConsumerState<DevicesScreen> {
  String? _busyKey;
  String? _error;

  Future<void> _activate(Endpoint endpoint) async {
    if (_busyKey != null || endpoint.storageKey == _activeKey) return;
    setState(() {
      _busyKey = endpoint.storageKey;
      _error = null;
    });
    try {
      final client = ApiClient(endpoint);
      if (!await client.healthz()) throw Exception('health check failed');
      await client.listSessions();
      await ref.read(endpointStorageProvider).activate(endpoint.storageKey);
      ref.read(endpointProvider.notifier).state = endpoint;
      if (mounted) context.go('/sessions');
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = 'Could not connect to ${endpoint.deviceName}. $error',
        );
      }
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  String? get _activeKey => ref.read(endpointProvider)?.storageKey;

  Future<void> _remove(Endpoint endpoint) async {
    if (_busyKey != null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('Remove ${endpoint.deviceName}?'),
        content: const Text(
          'This removes the saved binding from this phone. You can add the device again with a new QR code.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.pop(dialogContext, true),
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(
                dialogContext,
              ).colorScheme.errorContainer,
              foregroundColor: Theme.of(
                dialogContext,
              ).colorScheme.onErrorContainer,
            ),
            child: const Text('Remove device'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final removingActive = endpoint.storageKey == _activeKey;

    setState(() {
      _busyKey = endpoint.storageKey;
      _error = null;
    });
    try {
      try {
        await ApiClient(endpoint).revokeBinding();
      } catch (error) {
        debugPrint('[devices] server revoke failed: $error');
      }
      final collection = await ref
          .read(endpointStorageProvider)
          .remove(endpoint.storageKey);
      ref.read(savedEndpointsProvider.notifier).state = collection.endpoints;
      if (removingActive) {
        ref.read(endpointProvider.notifier).state = collection.active;
      }
      if (!mounted) return;
      if (removingActive) {
        context.go(collection.active == null ? '/pair' : '/sessions');
      }
    } finally {
      if (mounted) setState(() => _busyKey = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final endpoints = ref.watch(savedEndpointsProvider);
    final activeKey = ref.watch(endpointProvider)?.storageKey;
    final colors = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('DEVICES')),
      body: SafeArea(
        child: Column(
          children: [
            if (_error != null)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(12, 10, 12, 0),
                padding: const EdgeInsets.all(12),
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
              child: ListView.separated(
                padding: const EdgeInsets.all(12),
                itemCount: endpoints.length,
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) {
                  final endpoint = endpoints[index];
                  final active = endpoint.storageKey == activeKey;
                  final busy = endpoint.storageKey == _busyKey;
                  final uri = Uri.tryParse(endpoint.baseUrl);
                  return Card(
                    margin: EdgeInsets.zero,
                    clipBehavior: Clip.antiAlias,
                    child: ListTile(
                      minVerticalPadding: 12,
                      leading: CircleAvatar(
                        backgroundColor: active
                            ? colors.primaryContainer
                            : colors.surfaceContainerHighest,
                        child: Icon(
                          Icons.computer_rounded,
                          color: active
                              ? colors.onPrimaryContainer
                              : colors.onSurfaceVariant,
                        ),
                      ),
                      title: Text(
                        endpoint.deviceName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        '${uri?.host.isNotEmpty == true ? uri!.host : endpoint.baseUrl}${active ? ' · Current' : ''}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: busy
                          ? const SizedBox.square(
                              dimension: 22,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : PopupMenuButton<String>(
                              tooltip: 'Device actions',
                              onSelected: (action) {
                                if (action == 'switch') {
                                  _activate(endpoint);
                                } else if (action == 'remove') {
                                  _remove(endpoint);
                                }
                              },
                              itemBuilder: (_) => [
                                if (!active)
                                  const PopupMenuItem(
                                    value: 'switch',
                                    child: Text('Switch to device'),
                                  ),
                                const PopupMenuItem(
                                  value: 'remove',
                                  child: Text('Remove device'),
                                ),
                              ],
                            ),
                      selected: active,
                      selectedTileColor: colors.primaryContainer.withValues(
                        alpha: 0.22,
                      ),
                      onTap: active || busy ? null : () => _activate(endpoint),
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _busyKey == null
                      ? () => context.push('/pair?add=1')
                      : null,
                  icon: const Icon(Icons.qr_code_scanner_rounded),
                  label: const Text('Add device with QR code'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
