/// 配对屏:扫码或手输 host/port/token,验证连通后保存。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_zxing/flutter_zxing.dart';

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
  bool _testing = false;
  String? _error;

  final _hostCtrl = TextEditingController(text: '');
  final _portCtrl = TextEditingController(text: '47870');
  final _tokenCtrl = TextEditingController();

  @override
  void dispose() {
    _hostCtrl.dispose();
    _portCtrl.dispose();
    _tokenCtrl.dispose();
    super.dispose();
  }

  void _applyEndpoint(Endpoint ep) {
    _hostCtrl.text = ep.host;
    _portCtrl.text = ep.port.toString();
    _tokenCtrl.text = ep.token;
    setState(() {
      _scanning = false;
      _error = null;
    });
  }

  Future<void> _testAndSave() async {
    setState(() {
      _testing = true;
      _error = null;
    });

    final port = int.tryParse(_portCtrl.text.trim()) ?? -1;
    if (_hostCtrl.text.trim().isEmpty ||
        port <= 0 ||
        _tokenCtrl.text.trim().isEmpty) {
      setState(() {
        _error = 'fill host / port / token';
        _testing = false;
      });
      return;
    }

    final ep = Endpoint(
      host: _hostCtrl.text.trim(),
      port: port,
      token: _tokenCtrl.text.trim(),
    );

    final client = ApiClient(ep);
    try {
      final ok = await client.healthz();
      if (!ok) {
        setState(() {
          _error = 'healthz did not return "ok"';
          _testing = false;
        });
        return;
      }
      // 也验一下 bearer 能用
      await client.listSessions();
    } on ApiException catch (e) {
      debugPrint('[pair] API error: $e');
      setState(() {
        _error = '${e.error}: ${e.detail}';
        _testing = false;
      });
      return;
    } catch (e, st) {
      debugPrint('[pair] connect error: $e\n$st');
      setState(() {
        _error = 'connect: $e';
        _testing = false;
      });
      return;
    }

    // 保存 + 进 home。save 失败(keychain 弹窗 / 权限)只 log,继续设 endpoint。
    try {
      await ref
          .read(endpointStorageProvider)
          .save(ep)
          .timeout(const Duration(milliseconds: 1500));
    } catch (e) {
      debugPrint('[pair] save failed (will skip persistence): $e');
    }
    ref.read(endpointProvider.notifier).state = ep;
    if (!mounted) return;
    context.go('/sessions');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('PAIR WITH KODE')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: ListView(
            children: [
              if (_scanning) _buildScanner() else _buildScanCta(),
              const SizedBox(height: 16),
              const Text(
                'OR ENTER MANUALLY',
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.2,
                  color: KillLaColors.accent,
                ),
              ),
              const SizedBox(height: 8),
              _input('Host', _hostCtrl, 'e.g. 100.x.x.x or mac.tail-scale.ts'),
              _input(
                'Port',
                _portCtrl,
                '47870',
                keyboardType: TextInputType.number,
              ),
              _input(
                'Bearer token',
                _tokenCtrl,
                'paste token from desktop "Show Pairing QR…" dialog',
              ),
              const SizedBox(height: 12),
              if (_error != null)
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: KillLaColors.danger.withValues(alpha: 0.12),
                    border: Border(
                      left: BorderSide(color: KillLaColors.danger, width: 4),
                    ),
                  ),
                  child: Text(
                    _error!,
                    style: const TextStyle(
                      color: KillLaColors.danger,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
              FilledButton.icon(
                icon: _testing
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Icon(Icons.check_circle_outline, size: 18),
                onPressed: _testing ? null : _testAndSave,
                label: const Text('TEST CONNECTION & SAVE'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildScanCta() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: KillLaColors.bgSecondary,
        border: Border.all(color: KillLaColors.accent, width: 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'SCAN PAIRING QR',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w900,
              letterSpacing: 1.2,
              color: KillLaColors.accent,
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'On desktop GUI, open Command Palette (⌘P) → "Show Pairing QR…", then scan.',
            style: TextStyle(color: KillLaColors.textSecondary),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: () => setState(() => _scanning = true),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('OPEN CAMERA'),
          ),
        ],
      ),
    );
  }

  Widget _buildScanner() {
    return SizedBox(
      height: 320,
      child: Stack(
        children: [
          ReaderWidget(
            onScan: (result) async {
              // ReaderWidget 每帧触发,已接受码后早退避免重复 _applyEndpoint
              if (!_scanning) return;
              final raw = result.text;
              if (raw == null || raw.isEmpty) return;
              final ep = Endpoint.tryParseUri(raw);
              if (ep != null) {
                _applyEndpoint(ep);
              } else {
                setState(() => _error = 'not a kode pairing QR: $raw');
              }
            },
          ),
          Positioned(
            top: 8,
            right: 8,
            child: IconButton.filledTonal(
              icon: const Icon(Icons.close),
              onPressed: () => setState(() => _scanning = false),
            ),
          ),
        ],
      ),
    );
  }

  Widget _input(
    String label,
    TextEditingController ctrl,
    String hint, {
    TextInputType? keyboardType,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: TextField(
        controller: ctrl,
        keyboardType: keyboardType,
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
