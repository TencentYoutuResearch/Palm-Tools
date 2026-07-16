/// 协议数据模型 —— 与 docs/PROTOCOL.md v1 对齐。
///
/// 凡事故意手写 from/to JSON,不引 build_runner / json_serializable —— 启动期
/// 编译时间一倍以上,而 schema 字段就这么多,值不当那个。
library protocol;

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
  final String host;
  final int port;
  final String token;
  final String? serverKind; // 'rust-bridge',首次连上后从 connection.hello 拿

  Endpoint({
    required this.host,
    required this.port,
    required this.token,
    this.serverKind,
  });

  String get baseUrl => 'http://$host:$port';
  String get wsUrl =>
      'ws://$host:$port/ws?token=${Uri.encodeQueryComponent(token)}';

  Map<String, dynamic> toJson() => {
    'host': host,
    'port': port,
    'token': token,
    if (serverKind != null) 'server_kind': serverKind,
  };

  factory Endpoint.fromJson(Map<String, dynamic> j) => Endpoint(
    host: j['host'] as String,
    port: (j['port'] as num).toInt(),
    token: j['token'] as String,
    serverKind: j['server_kind'] as String?,
  );

  /// 从 `kode://pair?host=…&port=…&token=…` URI 解析。
  /// 兼容 `kodepair://` 前缀(部分 OS scheme 限制)。
  static Endpoint? tryParseUri(String raw) {
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
    if (uri.host != 'pair' && uri.path != 'pair' && uri.path != '/pair') {
      return null;
    }
    final host = uri.queryParameters['host'];
    final port = int.tryParse(uri.queryParameters['port'] ?? '');
    final token = uri.queryParameters['token'];
    if (host == null || host.isEmpty || port == null || token == null) {
      return null;
    }
    return Endpoint(host: host, port: port, token: token);
  }

  Endpoint copyWith({
    String? host,
    int? port,
    String? token,
    String? serverKind,
  }) => Endpoint(
    host: host ?? this.host,
    port: port ?? this.port,
    token: token ?? this.token,
    serverKind: serverKind ?? this.serverKind,
  );
}
