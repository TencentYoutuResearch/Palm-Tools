import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/sessions/sessions_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

final _endpoint = Endpoint(
  serverUrl: 'https://sync.example.com',
  token: 'test',
  deviceId: 'office',
  deviceName: 'Office Mac',
);

SessionDto _session(int id, String title) => SessionDto(
  id: id,
  backendKey: 'codex',
  title: title,
  model: 'gpt-test',
  status: 'idle',
  cwd: '/work/app',
  tokens: TokensDto(),
);

class _Api extends ApiClient {
  _Api(this.receipt) : super(_endpoint);

  InputDispatchReceipt receipt;
  Object? failure;
  final deleted = <int>[];

  @override
  Future<List<SessionDto>> listSessions() async => [
    _session(2, 'Remove me'),
    _session(1, 'Keep me'),
  ];

  @override
  Future<InputDispatchReceipt> deleteSession(int id) async {
    final failure = this.failure;
    if (failure != null) throw failure;
    deleted.add(id);
    return receipt;
  }
}

Future<ProviderContainer> _container(_Api api, {WSClient? ws}) async {
  final container = ProviderContainer(
    overrides: [
      endpointProvider.overrideWith((ref) => _endpoint),
      apiClientProvider.overrideWithValue(api),
      if (ws != null) wsClientProvider.overrideWithValue(ws),
    ],
  );
  await container.read(sessionsProvider.future);
  return container;
}

void main() {
  test('delete waits for the desktop to exit the session', () async {
    final api = _Api(
      const InputDispatchReceipt(commandId: 'cmd-1', status: 'dispatched'),
    );
    final ws = WSClient(_endpoint);
    addTearDown(ws.dispose);
    final container = await _container(api, ws: ws);
    addTearDown(container.dispose);

    final pending = container.read(sessionsProvider.notifier).delete(2);
    await Future<void>.delayed(Duration.zero);
    ws.debugAddEvent(
      Envelope(
        protocolVersion: 'v1',
        schemaVersion: 1,
        sessionId: 2,
        ts: 1,
        type: 'session.exited',
        payload: const {'reason': 'deleted_by_api'},
      ),
    );
    await pending;

    expect(api.deleted, [2]);
    expect(
      container.read(sessionsProvider).value!.map((session) => session.id),
      [1],
    );
  });

  test('a rejected delete leaves the session in the list', () async {
    final api = _Api(
      const InputDispatchReceipt(commandId: 'cmd-1', status: 'dispatched'),
    );
    final ws = WSClient(_endpoint);
    addTearDown(ws.dispose);
    final container = await _container(api, ws: ws);
    addTearDown(container.dispose);

    final pending = container.read(sessionsProvider.notifier).delete(2);
    await Future<void>.delayed(Duration.zero);
    ws.debugAddEvent(
      Envelope(
        protocolVersion: 'v1',
        schemaVersion: 1,
        sessionId: 2,
        ts: 1,
        type: 'command.status',
        payload: const {
          'command_id': 'cmd-1',
          'status': 'failed',
          'error': 'desktop is offline',
        },
      ),
    );

    await expectLater(pending, throwsA(isA<ApiException>()));
    expect(
      container.read(sessionsProvider).value!.map((session) => session.id),
      contains(2),
    );
  });

  testWidgets('swiping a session left asks before deleting it', (tester) async {
    final api = _Api(
      const InputDispatchReceipt(commandId: null, status: 'executed'),
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointProvider.overrideWith((ref) => _endpoint),
          apiClientProvider.overrideWithValue(api),
          wsClientProvider.overrideWith((ref) => null),
          eventStreamProvider.overrideWith((ref) => const Stream.empty()),
        ],
        child: MaterialApp(
          theme: KillLaTheme.dark(),
          home: const SessionsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.drag(
      find.byKey(const ValueKey('session-2')),
      const Offset(-500, 0),
    );
    await tester.pumpAndSettle();
    expect(find.text('Delete session?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Remove me'), findsOneWidget);
    expect(api.deleted, isEmpty);

    await tester.drag(
      find.byKey(const ValueKey('session-2')),
      const Offset(-500, 0),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();

    expect(find.text('Remove me'), findsNothing);
    expect(find.text('Keep me'), findsOneWidget);
    expect(api.deleted, [2]);
  });

  testWidgets('a failed swipe delete puts the session back', (tester) async {
    final api = _Api(
      const InputDispatchReceipt(commandId: null, status: 'executed'),
    )..failure = ApiException(409, 'conflict', 'desktop is offline');
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointProvider.overrideWith((ref) => _endpoint),
          apiClientProvider.overrideWithValue(api),
          wsClientProvider.overrideWith((ref) => null),
          eventStreamProvider.overrideWith((ref) => const Stream.empty()),
        ],
        child: MaterialApp(
          theme: KillLaTheme.dark(),
          home: const SessionsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.drag(
      find.byKey(const ValueKey('session-2')),
      const Offset(-500, 0),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();

    expect(find.text('Remove me'), findsOneWidget);
    expect(find.text('desktop is offline'), findsOneWidget);
  });
}
