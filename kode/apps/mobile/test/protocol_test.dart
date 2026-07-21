/// 协议解析单元测试 —— 与 Rust / Go 端 Envelope / SessionDto 字段对齐。
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  group('AskUserQuestion grouping', () {
    test('groups expanded questions from one tool call', () {
      expect(askQuestionGroupId('tooluse-abc-0'), 'tooluse-abc');
      expect(askQuestionGroupId('tooluse-abc-1'), 'tooluse-abc');
      expect(askQuestionGroupId('standalone'), 'standalone');
    });
  });

  group('Endpoint.tryParseUri', () {
    test('parses kode://pair correctly', () {
      final ep = Endpoint.tryParseUri(
        'kode://pair?host=100.64.0.1&port=9870&token=abc123',
      );
      expect(ep, isNotNull);
      expect(ep!.host, '100.64.0.1');
      expect(ep.port, 9870);
      expect(ep.token, 'abc123');
    });

    test('rejects wrong scheme', () {
      expect(Endpoint.tryParseUri('http://example.com'), isNull);
    });

    test('rejects missing fields', () {
      expect(Endpoint.tryParseUri('kode://pair?host=x'), isNull);
      expect(Endpoint.tryParseUri('kode://pair?port=9'), isNull);
    });

    test('handles encoded host', () {
      final ep = Endpoint.tryParseUri(
        'kode://pair?host=mac.tail-net.ts&port=9870&token=t',
      );
      expect(ep, isNotNull);
      expect(ep!.host, 'mac.tail-net.ts');
    });

    test('builds correct base/ws URLs', () {
      final ep = Endpoint(host: '1.2.3.4', port: 9870, token: 'T0kEn');
      expect(ep.baseUrl, 'http://1.2.3.4:9870');
      expect(ep.wsUrl, 'ws://1.2.3.4:9870/ws?token=T0kEn');
    });
  });

  group('Envelope', () {
    test('parses minimal envelope', () {
      final e = Envelope.fromJson({
        'protocol_version': 'v1',
        'schema_version': 1,
        'session_id': 7,
        'ts': 1700000000000,
        'type': 'message',
        'payload': {'role': 'user', 'text': 'hi'},
      });
      expect(e.type, 'message');
      expect(e.sessionId, 7);
      expect(e.payload['role'], 'user');
    });

    test('handles missing optional fields with defaults', () {
      final e = Envelope.fromJson({
        'session_id': 1,
        'ts': 1,
        'type': 'meta',
        'payload': {},
      });
      expect(e.protocolVersion, 'v1');
      expect(e.schemaVersion, 1);
    });
  });

  group('SessionDto', () {
    test('parses full payload', () {
      final s = SessionDto.fromJson({
        'id': 42,
        'backend_key': 'codebuddy',
        'title': 'fix nav',
        'model': 'claude-opus-4.7',
        'status': 'busy',
        'cwd': '/Users/foo/proj',
        'session_uuid': 'abc-123',
        'tokens': {'input': 1000, 'output': 200, 'cached': 50, 'total': 1200},
        'context_pct': 12.5,
        'cost_usd': 0.0123,
      });
      expect(s.id, 42);
      expect(s.title, 'fix nav');
      expect(s.tokens.cached, 50);
      expect(s.contextPct, 12.5);
    });

    test('tolerates missing tokens / context', () {
      final s = SessionDto.fromJson({
        'id': 1,
        'backend_key': 'echo',
        'title': '',
        'model': 'auto',
        'status': 'starting',
      });
      expect(s.tokens.total, 0);
      expect(s.contextPct, isNull);
    });
  });
}
