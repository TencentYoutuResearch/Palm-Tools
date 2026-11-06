import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/account_client.dart';
import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../glass.dart';
import '../palm/palm_capture_screen.dart';

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
    // Account desktops are listed by the account section, not as bindings.
    final endpoints = ref
        .watch(savedEndpointsProvider)
        .where((endpoint) => !endpoint.isRelay)
        .toList(growable: false);
    final activeKey = ref.watch(endpointProvider)?.storageKey;
    final signedIn = ref.watch(accountProvider) != null;
    final colors = Theme.of(context).colorScheme;

    return GlassScaffold(
      appBar: GlassAppBar(title: const Text('Devices')),
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
              child: ListView.separated(
                padding: const EdgeInsets.all(12),
                itemCount: endpoints.length + (signedIn ? 1 : 0),
                separatorBuilder: (_, _) => const SizedBox(height: 8),
                itemBuilder: (context, index) {
                  if (signedIn && index == 0) {
                    return _AccountDesktops(
                      busy: _busyKey != null,
                      onActivate: _activate,
                      onboard: ref.read(accountOnboardingProvider),
                    );
                  }
                  final endpoint = endpoints[index - (signedIn ? 1 : 0)];
                  final active = endpoint.storageKey == activeKey;
                  final busy = endpoint.storageKey == _busyKey;
                  final uri = Uri.tryParse(endpoint.baseUrl);
                  return GlassSurface(
                    child: ListTile(
                      minVerticalPadding: 12,
                      leading: CircleAvatar(
                        backgroundColor: active
                            ? colors.primary.withValues(alpha: .12)
                            : colors.onSurface.withValues(alpha: .04),
                        child: Icon(
                          Icons.computer_rounded,
                          color: active
                              ? colors.primary
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
                      onTap: active || _busyKey != null
                          ? null
                          : () => _activate(endpoint),
                    ),
                  );
                },
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
                    onPressed: _busyKey == null
                        ? () => context.push('/pair?add=1')
                        : null,
                    icon: const Icon(Icons.qr_code_scanner_rounded),
                    label: const Text('Add device with QR code'),
                  ),
                ),
              ),
            ),
            if (!signedIn)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: TextButton.icon(
                  onPressed: _busyKey == null
                      ? () => context.push('/login')
                      : null,
                  icon: const Icon(Icons.account_circle_outlined),
                  label: const Text('Sign in with a Kode account'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Desktops signed in to the same Kode account. Opening one starts its live
/// stream; nothing is uploaded for desktops the phone is not viewing.
class _AccountDesktops extends ConsumerStatefulWidget {
  const _AccountDesktops({
    required this.busy,
    required this.onActivate,
    this.onboard = false,
  });

  /// Just signed in: offer to set a name and enrol a palm.
  final bool onboard;

  final bool busy;
  final Future<void> Function(Endpoint endpoint) onActivate;

  @override
  ConsumerState<_AccountDesktops> createState() => _AccountDesktopsState();
}

class _AccountDesktopsState extends ConsumerState<_AccountDesktops> {
  Future<List<AccountDevice>>? _devices;

  /// Null until known, or when the relay or this device can't do palm.
  PalmConfig? _palm;
  bool _palmEnrolled = false;
  bool _palmBusy = false;

  @override
  void initState() {
    super.initState();
    _reload();
    _loadPalm();
  }

  Future<void> _loadPalm() async {
    final notifier = ref.read(accountProvider.notifier);
    final client = ref.read(accountClientProvider);
    try {
      if (!await palmCaptureSupported()) return;
      final session = await notifier.ensureFresh();
      if (session == null) return;
      final config = await client.palmConfig(session.serverUrl);
      final enrolled = await client.palmEnrolled(session);
      if (!mounted) return;
      setState(() {
        _palm = config;
        _palmEnrolled = enrolled;
      });
    } catch (_) {
      // Palm is optional; the menu simply omits it.
    }
    if (widget.onboard && ref.read(accountOnboardingProvider)) {
      ref.read(accountOnboardingProvider.notifier).state = false;
      await _onboard();
    }
  }

  Future<void> _palmAction(Future<String?> Function() action) async {
    if (_palmBusy) return;
    setState(() => _palmBusy = true);
    String? message;
    try {
      message = await action();
    } on ApiException catch (error) {
      message = error.detail;
    } catch (error) {
      message = '$error';
    } finally {
      if (mounted) setState(() => _palmBusy = false);
    }
    if (message != null && mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  Future<void> _enrolPalm() => _palmAction(() async {
    final palm = _palm;
    final client = ref.read(accountClientProvider);
    final session = await ref.read(accountProvider.notifier).ensureFresh();
    if (palm == null || session == null) return null;
    final token = await client.palmEnrollToken(session);
    if (!mounted) return null;
    final result = await capturePalm(
      context,
      palm.captureUri(
        mode: 'registration',
        token: token,
        userId: session.userId,
      ),
      enrol: true,
    );
    if (result == null || result.code == 10002) return null;
    if (result.code != 0) return result.friendly;
    final enrolled = await client.palmEnrolled(session);
    if (mounted) setState(() => _palmEnrolled = enrolled);
    return enrolled
        ? 'Palm enrolled. You can now sign in with your palm.'
        : 'The palm was not saved. Try again.';
  });

  Future<void> _rename() => _palmAction(() async {
    final session = ref.read(accountProvider);
    final name = await askAccountName(context, initial: session?.name ?? '');
    if (name == null) return null;
    await ref.read(accountProvider.notifier).setName(name);
    return null;
  });

  /// After a sign-in, asks once for what the account is missing: a name,
  /// then (where palm sign-in works) an enrolled palm.
  Future<void> _onboard() async {
    final session = ref.read(accountProvider);
    if (session == null || !mounted) return;
    if (session.name.trim().isEmpty) {
      final name = await askAccountName(context, initial: '', first: true);
      if (name != null) {
        await _palmAction(() async {
          await ref.read(accountProvider.notifier).setName(name);
          return null;
        });
      }
    }
    if (!mounted || _palm == null || _palmEnrolled) return;
    final enrol = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign in with your palm next time?'),
        content: const Text(
          'Enrol your palm once on this phone. Then sign in here, or on '
          'your computer, with just a palm scan.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Not now'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Enrol palm'),
          ),
        ],
      ),
    );
    if (enrol == true) await _enrolPalm();
  }

  Future<void> _forgetPalm() => _palmAction(() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete your palm?'),
        content: Text(
          ref.read(accountProvider)?.email.isEmpty ?? true
              ? 'This account has no email. Once your palm is deleted '
                    'nobody can sign in to it again, on any device.'
              : 'Your palm features are deleted from Tencent Palm and you '
                    'can no longer sign in with your palm until you enrol '
                    'again. Email sign-in keeps working.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return null;
    final session = await ref.read(accountProvider.notifier).ensureFresh();
    if (session == null) return null;
    await ref.read(accountClientProvider).forgetPalm(session);
    if (mounted) setState(() => _palmEnrolled = false);
    return 'Palm deleted.';
  });

  void _reload() {
    final session = ref.read(accountProvider);
    if (session == null) return;
    setState(() {
      _devices = ref.read(accountClientProvider).devices(session);
    });
  }

  Future<void> _open(AccountSession session, AccountDevice device) async {
    final endpoint = session.endpointFor(device);
    // Save first: activation navigates away and unmounts this widget. The
    // next launch reopens the desktop; bootstrap probes it before use.
    final storage = ref.read(endpointStorageProvider);
    await storage.save(endpoint);
    ref.read(savedEndpointsProvider.notifier).state =
        (await storage.loadCollection()).endpoints;
    await widget.onActivate(endpoint);
  }

  Future<void> _signOut() async {
    await ref.read(accountProvider.notifier).signOut();
    if (!mounted) return;
    if (ref.read(endpointProvider) == null) context.go('/pair');
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(accountProvider);
    final activeKey = ref.watch(endpointProvider)?.storageKey;
    final colors = Theme.of(context).colorScheme;
    if (session == null) return const SizedBox.shrink();
    return GlassSurface(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ListTile(
              leading: CircleAvatar(
                backgroundColor: colors.primary,
                foregroundColor: colors.onPrimary,
                foregroundImage: session.picture.isEmpty
                    ? null
                    : NetworkImage(session.picture),
                child: Text(
                  session.label.substring(0, 1).toUpperCase(),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              title: Text(
                session.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(
                [
                  switch (session.method) {
                    LoginMethod.palm => 'Kode account · palm',
                    LoginMethod.email => 'Kode account · email',
                  },
                  if (_palm != null && _palmEnrolled) 'palm enrolled',
                ].join(' · '),
              ),
              trailing: PopupMenuButton<String>(
                tooltip: 'Account actions',
                enabled: !_palmBusy,
                onSelected: (action) {
                  if (action == 'refresh') _reload();
                  if (action == 'rename') _rename();
                  if (action == 'palm_enrol') _enrolPalm();
                  if (action == 'palm_forget') _forgetPalm();
                  if (action == 'sign_out') _signOut();
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'refresh',
                    child: Text('Refresh desktops'),
                  ),
                  const PopupMenuItem(value: 'rename', child: Text('Rename')),
                  if (_palm != null)
                    _palmEnrolled
                        ? const PopupMenuItem(
                            value: 'palm_forget',
                            child: Text('Delete palm'),
                          )
                        : const PopupMenuItem(
                            value: 'palm_enrol',
                            child: Text('Enrol palm'),
                          ),
                  const PopupMenuItem(
                    value: 'sign_out',
                    child: Text('Sign out'),
                  ),
                ],
              ),
            ),
            FutureBuilder<List<AccountDevice>>(
              future: _devices,
              builder: (context, snapshot) {
                if (snapshot.connectionState != ConnectionState.done) {
                  return const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(
                      child: SizedBox.square(
                        dimension: 22,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  );
                }
                if (snapshot.hasError) {
                  return ListTile(
                    title: const Text('Could not load desktops'),
                    subtitle: Text('${snapshot.error}'),
                    trailing: IconButton(
                      tooltip: 'Retry',
                      icon: const Icon(Icons.refresh_rounded),
                      onPressed: _reload,
                    ),
                  );
                }
                final devices = snapshot.data ?? const [];
                if (devices.isEmpty) {
                  return const ListTile(
                    title: Text('No desktops yet'),
                    subtitle: Text(
                      'Sign in to this account in Kode on your computer.',
                    ),
                  );
                }
                return Column(
                  children: [
                    for (final device in devices)
                      ListTile(
                        leading: Icon(
                          Icons.computer_rounded,
                          color: device.online
                              ? colors.primary
                              : colors.onSurfaceVariant,
                        ),
                        title: Text(
                          device.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text(
                          [
                            device.online ? 'Online' : 'Offline',
                            if (session.endpointFor(device).storageKey ==
                                activeKey)
                              'Current',
                          ].join(' · '),
                        ),
                        enabled: device.online && !widget.busy,
                        onTap: () => _open(session, device),
                      ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// Asks for the account's display name; null when cancelled.
Future<String?> askAccountName(
  BuildContext context, {
  required String initial,
  bool first = false,
}) async {
  final controller = TextEditingController(text: initial);
  final name = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(first ? 'What should Kode call you?' : 'Rename account'),
      content: TextField(
        controller: controller,
        autofocus: true,
        maxLength: 32,
        textInputAction: TextInputAction.done,
        decoration: const InputDecoration(labelText: 'Name'),
        onSubmitted: (value) => Navigator.pop(context, value),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(first ? 'Skip' : 'Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text),
          child: const Text('Save'),
        ),
      ],
    ),
  );
  controller.dispose();
  final trimmed = name?.trim() ?? '';
  return trimmed.isEmpty ? null : trimmed;
}
