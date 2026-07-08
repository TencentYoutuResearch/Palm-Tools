/// 桌面端自动配对 — 不扫 QR,直接从本机读 kode GUI 的 state.json 拿 bridge_token,
/// 然后探测 bridge 实际监听的端口。
///
/// 触发条件:
///   1. 平台是 macOS / Linux(iOS / Android 不在同一文件系统)
///   2. dev 模式(release 仍走 sandbox / 不读他人目录)
///
/// 路径优先级(对齐 kode GUI 的 persistence::state_file_path):
///   1. macOS: $HOME/Library/Application Support/kode/state.json
///   2. Linux: $HOME/.config/kode/state.json
///   3. 环境变量 `KODE_STATE_FILE` 显式覆盖(测试用)
///
/// 端口探测:host 始终 127.0.0.1,依次试:
///   1. `KODE_BRIDGE_PORT` env(如果传给了 Flutter 进程)
///   2. 47870(协议默认)
///   3. 9870(旧默认,向后兼容)
///   4. 29870(本仓常用 dev 端口)
///   5. 18870(避撞预留)
/// 第一个 /healthz 返 "ok" 且 token 校验通过的端口胜出。
library;

import 'dart:convert';
import 'dart:io';

import '../api/api_client.dart';
import '../protocol/protocol.dart';

class DesktopAutoPair {
  /// 候选端口顺序。命中第一个就返回。
  static const _candidatePorts = <int>[47870, 9870, 29870, 18870];

  /// 尝试自动发现 endpoint。
  /// 返回 null 表示:
  ///   - 不是支持的桌面平台
  ///   - state.json 不存在 / 无 bridge_token
  ///   - 所有候选端口都连不上
  static Future<Endpoint?> tryDiscover() async {
    final platform = _platformKey();
    if (platform == null) return null;

    final path = _resolveStatePath(platform);
    if (path == null) return null;
    final f = File(path);
    if (!await f.exists()) return null;

    String token;
    try {
      final raw = await f.readAsString();
      final json = jsonDecode(raw);
      if (json is! Map<String, dynamic>) return null;
      final t = json['bridge_token'] as String?;
      if (t == null || t.isEmpty) return null;
      token = t;
    } catch (_) {
      return null;
    }

    // 候选端口列表:env 优先,然后默认列表
    final ports = <int>[];
    final envPort =
        int.tryParse(Platform.environment['KODE_BRIDGE_PORT'] ?? '');
    if (envPort != null) ports.add(envPort);
    for (final p in _candidatePorts) {
      if (!ports.contains(p)) ports.add(p);
    }

    for (final port in ports) {
      final ep = Endpoint(host: '127.0.0.1', port: port, token: token);
      if (await _probe(ep)) return ep;
    }
    return null;
  }

  /// 探活:/healthz + listSessions 双重验证。后者验 Bearer 真生效。
  static Future<bool> _probe(Endpoint ep) async {
    try {
      final c = ApiClient(ep);
      if (!await c.healthz()) return false;
      await c.listSessions();
      return true;
    } catch (_) {
      return false;
    }
  }

  static String? _platformKey() {
    if (Platform.isMacOS) return 'macos';
    if (Platform.isLinux) return 'linux';
    return null;
  }

  static String? _resolveStatePath(String platform) {
    final override = Platform.environment['KODE_STATE_FILE'];
    if (override != null && override.trim().isNotEmpty) return override.trim();
    final home = Platform.environment['HOME'];
    if (home == null || home.isEmpty) return null;
    return switch (platform) {
      'macos' => '$home/Library/Application Support/kode/state.json',
      'linux' => '$home/.config/kode/state.json',
      _ => null,
    };
  }
}
