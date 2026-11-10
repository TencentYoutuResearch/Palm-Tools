import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/ui/sessions/session_relay_cards.dart';

SessionDto _session(String backend, String uuid, String title) => SessionDto(
  id: 1,
  backendKey: backend,
  title: title,
  model: '',
  status: 'idle',
  sessionUuid: uuid,
  tokens: TokensDto(),
);

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

void main() {
  final sessions = [_session('tclaude', 'abc', 'Review backend')];

  test('resolves kode-native addresses by backend and uuid', () {
    expect(sessionNameFor('kode:tclaude:abc', sessions), 'Review backend');
    expect(sessionNameFor('kode:codex:abc', sessions), unavailableSessionName);
    expect(sessionNameFor('session-123', sessions), unavailableSessionName);
    expect(sessionNameFor(null, sessions), unavailableSessionName);
  });

  test('hides only exact assistant echoes of an incoming envelope', () {
    const raw = '[Session message m-1 from n/kode:tclaude:abc]\nRun tests';
    expect(isRelayEcho(raw, [raw]), isTrue);
    expect(isRelayEcho('Codex: $raw', [raw]), isTrue);
    expect(isRelayEcho('Tests pass. $raw', [raw]), isFalse);
    expect(isRelayEcho('All 12 tests passed.', [raw]), isFalse);
  });

  test('tool status reports the send-time delivery state', () {
    final send = {
      'status': 'ok',
      'output_preview': '{"message":{"status":"accepted"}}',
      'relay_tool': {'op': 'send'},
    };
    expect(sessionToolStatus(send), 'At send: handed to the target session');
    expect(sessionToolStatus({'status': 'running'}), 'In progress');
    expect(sessionToolStatus({'status': 'error'}), 'Call failed');
    expect(
      sessionToolStatus({
        'status': 'ok',
        'output_preview': '{"timed_out":true}',
      }),
      'No new messages yet',
    );
    expect(
      sessionToolTitle({'op': 'send', 'in_reply_to': 'm-1'}),
      'Reply to session',
    );
    expect(sessionToolTitle({'op': 'wait'}), 'Wait for session reply');
  });

  testWidgets('incoming card shows names and content, never addresses', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        RelayMessageCard(
          relay: const {
            'message_id': 'm-1',
            'from_node': 'local-node',
            'from_session': 'kode:tclaude:abc',
            'content': 'Please run the tests',
          },
          currentTitle: 'Mobile app',
          sessions: sessions,
        ),
      ),
    );
    expect(find.text('Review backend'), findsOneWidget);
    expect(find.text('Mobile app (current)'), findsOneWidget);
    expect(find.text('Sent a message'), findsOneWidget);
    expect(find.text('Please run the tests'), findsOneWidget);
    expect(find.textContaining('kode:tclaude'), findsNothing);
    expect(find.textContaining('m-1'), findsNothing);
    expect(find.text('Show full message'), findsNothing);
  });

  testWidgets('long incoming content expands in place', (tester) async {
    final long = List.filled(6, 'line').join('\n');
    await tester.pumpWidget(
      _host(
        RelayMessageCard(
          relay: {
            'from_session': 'session-x',
            'reply_to': 'm-0',
            'content': long,
          },
          currentTitle: 'Mobile app',
          sessions: sessions,
        ),
      ),
    );
    expect(find.text('Replied to this conversation'), findsOneWidget);
    expect(find.text(unavailableSessionName), findsOneWidget);
    await tester.tap(find.text('Show full message'));
    await tester.pump();
    expect(find.text('Show less'), findsOneWidget);
  });

  testWidgets('send tool card shows target and delivery note when opened', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        SessionToolCard(
          payload: const {
            'status': 'ok',
            'output_preview': '{"message":{"status":"queued","id":"m-9"}}',
            'relay_tool': {
              'op': 'send',
              'node_id': 'local-node',
              'session_id': 'kode:tclaude:abc',
              'content': 'Can you review PR 29?',
            },
          },
          currentTitle: 'Mobile app',
          sessions: sessions,
        ),
      ),
    );
    expect(find.text('Send session message'), findsOneWidget);
    expect(find.text('At send: queued'), findsOneWidget);
    expect(find.text('Review backend'), findsOneWidget);
    expect(find.text('Can you review PR 29?'), findsOneWidget);
    expect(find.textContaining('m-9'), findsNothing);
    await tester.tap(find.text('Send session message'));
    await tester.pump();
    expect(
      find.text('Delivery status does not mean the target task is complete.'),
      findsOneWidget,
    );
  });
}
