// 协议解析单元测试 —— 与 Rust Envelope / SessionDto 字段对齐。
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

  group('PairingInvite.tryParseUri', () {
    test('parses centralized pairing URI', () {
      final invite = PairingInvite.tryParseUri(
        'kode://cloud-pair?server=https%3A%2F%2Fsync.example.com&pairing_id=pair_123&secret=kp_abc',
      );
      expect(invite, isNotNull);
      expect(invite!.serverUrl, 'https://sync.example.com');
      expect(invite.pairingId, 'pair_123');
      expect(invite.secret, 'kp_abc');
    });

    test('rejects wrong scheme', () {
      expect(PairingInvite.tryParseUri('http://example.com'), isNull);
    });

    test('rejects missing fields', () {
      expect(
        PairingInvite.tryParseUri(
          'kode://cloud-pair?server=https%3A%2F%2Fsync.example.com',
        ),
        isNull,
      );
    });

    test('rejects non-http server URLs', () {
      final invite = PairingInvite.tryParseUri(
        'kode://cloud-pair?server=file%3A%2F%2F%2Ftmp%2Fsync&pairing_id=p&secret=s',
      );
      expect(invite, isNull);
    });
  });

  group('Endpoint URLs', () {
    test('builds correct base/ws URLs', () {
      final ep = Endpoint(
        serverUrl: 'https://sync.example.com/',
        token: 'T0kEn',
        deviceId: 'dev_1',
        deviceName: 'Studio Mac',
      );
      expect(ep.baseUrl, 'https://sync.example.com');
      expect(ep.wsUrl, 'wss://sync.example.com/ws');
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

    test('copyWith updates live status without losing metadata', () {
      final s = SessionDto.fromJson({
        'id': 7,
        'backend_key': 'codex',
        'title': 'active task',
        'model': 'gpt-test',
        'status': 'idle',
        'cwd': '/tmp/project',
        'tokens': {'total': 12},
      });
      final busy = s.copyWith(status: 'busy');
      expect(busy.status, 'busy');
      expect(busy.title, 'active task');
      expect(busy.cwd, '/tmp/project');
      expect(busy.tokens.total, 12);
    });
  });
}
