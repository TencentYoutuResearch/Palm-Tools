/// 协议数据模型 —— 与 docs/PROTOCOL.md v1 对齐。
///
/// 凡事故意手写 from/to JSON,不引 build_runner / json_serializable —— 启动期
/// 编译时间一倍以上,而 schema 字段就这么多,值不当那个。
library;

import 'dart:convert';

/// Bridge expands one AskUserQuestion tool call into ids such as `call-0`,
/// `call-1`. Mobile groups them into one editable submit panel.
String askQuestionGroupId(String questionId) =>
    questionId.replaceFirst(RegExp(r'-\d+$'), '');

/// envelope 外壳。所有 WS / /history 事件都套这个。
class Envelope {
  final String protocolVersion;
  final int schemaVersion;
  final int sessionId;
  final int ts; // unix ms
  final String type;
  final Map<String, dynamic> payload;

  Envelope({
    required this.protocolVersion,
    required this.schemaVersion,
    required this.sessionId,
    required this.ts,
    required this.type,
    required this.payload,
  });

  factory Envelope.fromJson(Map<String, dynamic> j) => Envelope(
    protocolVersion: j['protocol_version'] as String? ?? 'v1',
    schemaVersion: (j['schema_version'] as num?)?.toInt() ?? 1,
    sessionId: (j['session_id'] as num).toInt(),
    ts: (j['ts'] as num).toInt(),
    type: j['type'] as String,
    payload: j['payload'] is Map<String, dynamic>
        ? j['payload'] as Map<String, dynamic>
        : (j['payload'] is String
              ? jsonDecode(j['payload'] as String) as Map<String, dynamic>
              : <String, dynamic>{}),
  );

  @override
  String toString() => 'Envelope($type sid=$sessionId ts=$ts)';
}

/// 协议 §4.1 / §5.3 session 对象。
class SessionDto {
  final int id;
  final String backendKey;
  final String title;
  final String model;
  final String status; // starting / idle / busy / exited
  final String? cwd;
  final String? sessionUuid;
  final TokensDto tokens;
  final double? contextPct;
  final double? costUsd;

  SessionDto({
    required this.id,
    required this.backendKey,
    required this.title,
    required this.model,
    required this.status,
    this.cwd,
    this.sessionUuid,
    required this.tokens,
    this.contextPct,
    this.costUsd,
  });

  factory SessionDto.fromJson(Map<String, dynamic> j) => SessionDto(
    id: (j['id'] as num).toInt(),
    backendKey: j['backend_key'] as String? ?? '?',
    title: j['title'] as String? ?? '',
    model: j['model'] as String? ?? 'auto',
    status: j['status'] as String? ?? 'starting',
    cwd: j['cwd'] as String?,
    sessionUuid: j['session_uuid'] as String?,
    tokens: TokensDto.fromJson(
      (j['tokens'] as Map<String, dynamic>? ?? const {}),
    ),
    contextPct: (j['context_pct'] as num?)?.toDouble(),
    costUsd: (j['cost_usd'] as num?)?.toDouble(),
  );

  SessionDto copyWith({
    String? title,
    String? model,
    String? status,
    TokensDto? tokens,
    double? contextPct,
    double? costUsd,
  }) => SessionDto(
    id: id,
    backendKey: backendKey,
    title: title ?? this.title,
    model: model ?? this.model,
    status: status ?? this.status,
    cwd: cwd,
    sessionUuid: sessionUuid,
    tokens: tokens ?? this.tokens,
    contextPct: contextPct ?? this.contextPct,
    costUsd: costUsd ?? this.costUsd,
  );
}

class TokensDto {
  final int input, output, cached, total;
  TokensDto({this.input = 0, this.output = 0, this.cached = 0, this.total = 0});
  factory TokensDto.fromJson(Map<String, dynamic> j) => TokensDto(
    input: (j['input'] as num?)?.toInt() ?? 0,
    output: (j['output'] as num?)?.toInt() ?? 0,
    cached: (j['cached'] as num?)?.toInt() ?? 0,
    total: (j['total'] as num?)?.toInt() ?? 0,
  );
}

/// 鉴权 + 端点的本地存储模型。
///
/// 对应 docs/PROTOCOL.md §3 + 配对屏存储下来的内容。
class Endpoint {
  final String serverUrl;
  final String token;
  final String deviceId;
  final String deviceName;
  final String? serverKind;

  Endpoint({
    required this.serverUrl,
    required this.token,
    required this.deviceId,
    required this.deviceName,
    this.serverKind,
  });

  String get baseUrl => serverUrl.replaceAll(RegExp(r'/+$'), '');
  String get storageKey => '$baseUrl::$deviceId';
  String get wsUrl {
    final uri = Uri.parse(baseUrl);
    return uri
        .replace(
          scheme: uri.scheme == 'https' ? 'wss' : 'ws',
          path: '${uri.path.replaceAll(RegExp(r'/+$'), '')}/ws',
        )
        .toString();
  }

  Map<String, dynamic> toJson() => {
    'server_url': serverUrl,
    'token': token,
    'device_id': deviceId,
    'device_name': deviceName,
    if (serverKind != null) 'server_kind': serverKind,
  };

  factory Endpoint.fromJson(Map<String, dynamic> j) => Endpoint(
    serverUrl: j['server_url'] as String,
    token: j['token'] as String,
    deviceId: j['device_id'] as String,
    deviceName: j['device_name'] as String? ?? 'Kode Desktop',
    serverKind: j['server_kind'] as String?,
  );

  Endpoint copyWith({
    String? serverUrl,
    String? token,
    String? deviceId,
    String? deviceName,
    String? serverKind,
  }) => Endpoint(
    serverUrl: serverUrl ?? this.serverUrl,
    token: token ?? this.token,
    deviceId: deviceId ?? this.deviceId,
    deviceName: deviceName ?? this.deviceName,
    serverKind: serverKind ?? this.serverKind,
  );
}

/// One-time QR payload. This is exchanged for a mobile access token and is
/// never stored after a successful claim.
class PairingInvite {
  final String serverUrl;
  final String pairingId;
  final String secret;

  const PairingInvite({
    required this.serverUrl,
    required this.pairingId,
    required this.secret,
  });

  static PairingInvite? tryParseUri(String raw) {
    final s = raw.trim();
    final Uri uri;
    try {
      uri = Uri.parse(s);
    } catch (_) {
      return null;
    }
    if (uri.scheme != 'kode' && uri.scheme != 'kodepair') {
      return null;
    }
    if (uri.host != 'cloud-pair' &&
        uri.path != 'cloud-pair' &&
        uri.path != '/cloud-pair') {
      return null;
    }
    final serverUrl = uri.queryParameters['server'];
    final pairingId = uri.queryParameters['pairing_id'];
    final secret = uri.queryParameters['secret'];
    if (serverUrl == null ||
        serverUrl.isEmpty ||
        pairingId == null ||
        pairingId.isEmpty ||
        secret == null ||
        secret.isEmpty) {
      return null;
    }
    final parsedServer = Uri.tryParse(serverUrl);
    if (parsedServer == null ||
        (parsedServer.scheme != 'http' && parsedServer.scheme != 'https') ||
        parsedServer.host.isEmpty) {
      return null;
    }
    return PairingInvite(
      serverUrl: serverUrl.replaceAll(RegExp(r'/+$'), ''),
      pairingId: pairingId,
      secret: secret,
    );
  }
}
