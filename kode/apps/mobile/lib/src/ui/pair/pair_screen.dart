// Centralized pairing: claim a one-time QR for a scoped mobile access token.
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_zxing/flutter_zxing.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../theme.dart';

class PairScreen extends ConsumerStatefulWidget {
  const PairScreen({super.key});

  @override
  ConsumerState<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends ConsumerState<PairScreen> {
  bool _scanning = false;
  bool _claiming = false;
  bool _showSecret = false;
  String? _error;

  final _serverCtrl = TextEditingController();
  final _pairingIdCtrl = TextEditingController();
  final _secretCtrl = TextEditingController();

  @override
  void dispose() {
    _serverCtrl.dispose();
    _pairingIdCtrl.dispose();
    _secretCtrl.dispose();
    super.dispose();
  }

  Future<void> _claim(PairingInvite invite) async {
    if (_claiming) return;
    setState(() {
      _claiming = true;
      _scanning = false;
      _error = null;
      _serverCtrl.text = invite.serverUrl;
      _pairingIdCtrl.text = invite.pairingId;
      _secretCtrl.text = invite.secret;
    });
    try {
      final endpoint = await ApiClient.claimPairing(invite);
      final client = ApiClient(endpoint);
      if (!await client.healthz()) {
        throw const FormatException('sync server health check failed');
      }
      await client.listSessions();
      try {
        final storage = ref.read(endpointStorageProvider);
        await storage.save(endpoint).timeout(const Duration(seconds: 2));
        ref.read(savedEndpointsProvider.notifier).state =
            (await storage.loadCollection()).endpoints;
      } catch (error) {
        debugPrint(
          '[pair] secure storage failed; using in-memory binding: $error',
        );
      }
      ref.read(endpointProvider.notifier).state = endpoint;
      if (mounted) context.go('/sessions');
    } on ApiException catch (error) {
      if (mounted) {
        setState(() => _error = _friendlyApiError(error));
      }
    } on DioException catch (error) {
      if (mounted) {
        setState(() => _error = _friendlyNetworkError(error));
      }
    } catch (error) {
      if (mounted) {
        setState(() => _error = 'Could not pair with the sync server.\n$error');
      }
    } finally {
      if (mounted) setState(() => _claiming = false);
    }
  }

  Future<void> _claimManual() async {
    final serverUrl = _serverCtrl.text.trim().replaceAll(RegExp(r'/+$'), '');
    final pairingId = _pairingIdCtrl.text.trim();
    final secret = _secretCtrl.text.trim();
    final parsed = Uri.tryParse(serverUrl);
    if (parsed == null ||
        (parsed.scheme != 'http' && parsed.scheme != 'https') ||
        parsed.host.isEmpty ||
        pairingId.isEmpty ||
        secret.isEmpty) {
      setState(() {
        _error = 'Enter the HTTPS server URL, pairing ID, and one-time secret.';
      });
      return;
    }
    await _claim(
      PairingInvite(serverUrl: serverUrl, pairingId: pairingId, secret: secret),
    );
  }

  String _friendlyApiError(ApiException error) {
    if (error.status == 409 && error.detail.contains('expired')) {
      return 'This pairing code has expired. Create a new code on the desktop and scan again.';
    }
    if (error.status == 409 && error.detail.contains('claimed')) {
      return 'This pairing code has already been used. Create a new code on the desktop.';
    }
    if (error.status == 401) {
      return 'The one-time secret is invalid. Scan the latest code shown on the desktop.';
    }
    return 'Pairing was rejected (${error.status}).\n${error.detail}';
  }

  String _friendlyNetworkError(DioException error) {
    if (error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout) {
      return 'The sync server timed out. Check its public URL and TLS configuration.';
    }
    return 'Cannot reach the sync server. Check that its HTTPS URL is public and the deployment is running.';
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('PAIR WITH KODE')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (_scanning) _buildScanner() else _buildScanCard(colors),
            const SizedBox(height: 16),
            _buildPermissionCard(colors),
            const SizedBox(height: 20),
            Text(
              'ENTER ONE-TIME CODE MANUALLY',
              style: TextStyle(
                color: colors.primary,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
              ),
            ),
            const SizedBox(height: 8),
            _input(
              label: 'Sync server URL',
              controller: _serverCtrl,
              hint: 'https://sync.example.com',
              keyboardType: TextInputType.url,
            ),
            _input(
              label: 'Pairing ID',
              controller: _pairingIdCtrl,
              hint: 'pair_…',
            ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: TextField(
                controller: _secretCtrl,
                obscureText: !_showSecret,
                enableSuggestions: false,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: 'One-time secret',
                  hintText: 'kp_…',
                  border: const OutlineInputBorder(),
                  isDense: true,
                  suffixIcon: IconButton(
                    tooltip: _showSecret ? 'Hide secret' : 'Show secret',
                    onPressed: () => setState(() => _showSecret = !_showSecret),
                    icon: Icon(
                      _showSecret ? Icons.visibility_off : Icons.visibility,
                    ),
                  ),
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: KillLaColors.danger.withValues(alpha: 0.12),
                  border: const Border(
                    left: BorderSide(color: KillLaColors.danger, width: 4),
                  ),
                ),
                child: Text(
                  _error!,
                  style: const TextStyle(
                    color: KillLaColors.danger,
                    fontWeight: FontWeight.w700,
                    height: 1.4,
                  ),
                ),
              ),
            ],
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: _claiming ? null : _claimManual,
              icon: _claiming
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Color(0xFF07100B),
                      ),
                    )
                  : const Icon(Icons.link, size: 18),
              label: Text(_claiming ? 'PAIRING…' : 'CLAIM PAIRING CODE'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildScanCard(ColorScheme colors) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.primary, width: 1.5),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'SCAN ONE-TIME QR',
            style: TextStyle(
              color: colors.primary,
              fontSize: 16,
              fontWeight: FontWeight.w900,
              letterSpacing: 1.2,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'On the desktop, open Command Palette (⌘P) → “Show Pairing QR…”. The code expires after two minutes and can be used once.',
            style: TextStyle(color: colors.onSurfaceVariant, height: 1.45),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: _claiming
                ? null
                : () => setState(() => _scanning = true),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('OPEN CAMERA'),
          ),
        ],
      ),
    );
  }

  Widget _buildPermissionCard(ColorScheme colors) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.outline),
        borderRadius: BorderRadius.circular(12),
      ),
      child: const Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.lock_outline, size: 20, color: KillLaColors.textSecondary),
          SizedBox(width: 10),
          Expanded(
            child: Text(
              'This binding can read synced sessions and send messages to them. The desktop remains the only executor, and offline messages are not queued.',
              style: TextStyle(color: KillLaColors.textSecondary, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildScanner() {
    return SizedBox(
      height: 340,
      child: Stack(
        children: [
          ReaderWidget(
            onScan: (result) {
              if (!_scanning || _claiming) return;
              final raw = result.text;
              if (raw == null || raw.isEmpty) return;
              final invite = PairingInvite.tryParseUri(raw);
              if (invite == null) {
                setState(
                  () => _error = 'This is not a kode cloud pairing QR code.',
                );
                return;
              }
              setState(() => _scanning = false);
              _claim(invite);
            },
          ),
          Positioned(
            top: 8,
            right: 8,
            child: IconButton.filledTonal(
              tooltip: 'Close scanner',
              onPressed: () => setState(() => _scanning = false),
              icon: const Icon(Icons.close),
            ),
          ),
        ],
      ),
    );
  }

  Widget _input({
    required String label,
    required TextEditingController controller,
    required String hint,
    TextInputType? keyboardType,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: TextField(
        controller: controller,
        keyboardType: keyboardType,
        autocorrect: false,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          border: const OutlineInputBorder(),
          isDense: true,
        ),
      ),
    );
  }
}
