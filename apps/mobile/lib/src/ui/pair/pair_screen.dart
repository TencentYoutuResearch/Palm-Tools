/// 配对屏:扫码或手输 host/port/token,验证连通后保存。
import 'dart:io';

import 'package:dio/dio.dart';
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
    final userHost = _hostCtrl.text.trim();
    final token = _tokenCtrl.text.trim();
    if (userHost.isEmpty || port <= 0 || token.isEmpty) {
      setState(() {
        _error = 'fill host / port / token';
        _testing = false;
      });
      return;
    }

    // 候选 host:用户输入优先。真机若不在 Mac 同子网 → No route to host,
    // 自动 fallback 试 127.0.0.1 —— 覆盖 Android 真机 + `adb reverse tcp:47870 tcp:47870` USB 调试。
    // iOS 真机 127.0.0.1 是手机自己,会快速 refused,不浪费时间。
    final candidates = <String>[userHost];
    if (userHost != '127.0.0.1' && userHost != 'localhost') {
      candidates.add('127.0.0.1');
    }

    Endpoint? working;
    String? lastError;
    for (final h in candidates) {
      final ep = Endpoint(host: h, port: port, token: token);
      try {
        final client = ApiClient(ep);
        final ok = await client.healthz();
        if (ok) {
          await client.listSessions();
          working = ep;
          break;
        }
        if (h == userHost) lastError = 'healthz did not return "ok"';
      } on ApiException catch (e) {
        debugPrint('[pair] API error on $h: $e');
        if (h == userHost) lastError = '${e.error}: ${e.detail}';
      } catch (e, st) {
        debugPrint('[pair] connect error on $h: $e\n$st');
        if (h == userHost) lastError = _friendlyConnectError(e, ep);
      }
    }

    if (working == null) {
      setState(() {
        _error = lastError ?? 'connect failed';
        _testing = false;
      });
      return;
    }

    if (working.host != userHost) {
      debugPrint(
        '[pair] fell back to ${working.host} (original $userHost unreachable)',
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Connected via ${working.host} (USB debug: original $userHost unreachable)',
            ),
            duration: const Duration(seconds: 4),
          ),
        );
      }
    }

    // 保存 + 进 home。save 失败(keychain 弹窗 / 权限)只 log,继续设 endpoint。
    try {
      await ref
          .read(endpointStorageProvider)
          .save(working)
          .timeout(const Duration(milliseconds: 1500));
    } catch (e) {
      debugPrint('[pair] save failed (will skip persistence): $e');
    }
    ref.read(endpointProvider.notifier).state = working;
    if (!mounted) return;
    context.go('/sessions');
  }

  /// 把底层 DioException / SocketException 翻译成可操作提示。
  /// "No route to host" 这类 OS 错误对用户没意义,得告诉用户下一步该查什么。
  String _friendlyConnectError(Object e, Endpoint ep) {
    var raw = e.toString();
    if (e is DioException) {
      final inner = e.error;
      if (inner is SocketException) {
        raw = inner.osError?.message ?? inner.message;
      } else if (inner != null) {
        raw = inner.toString();
      }
    }
    final lower = raw.toLowerCase();

    final String kind;
    if (lower.contains('no route to host') ||
        lower.contains('network is unreachable')) {
      kind = 'phone and Mac are not on the same WiFi subnet';
    } else if (lower.contains('connection refused')) {
      kind = 'connection refused (desktop bridge not running?)';
    } else if (lower.contains('timed out') || lower.contains('timeout')) {
      kind = 'timed out (firewall may be dropping packets)';
    } else {
      kind = 'cannot reach host';
    }

    return 'Cannot connect to ${ep.host}:${ep.port}\n'
        '$kind.\n'
        'Fix:\n'
        '  · join same WiFi as Mac\n'
        '  · Android USB: `adb reverse tcp:${ep.port} tcp:${ep.port}` then retry\n'
        '  · or install Tailscale on both devices';
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
