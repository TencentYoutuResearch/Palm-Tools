import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/sessions/sessions_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

SessionDto _session({required int id, required String title}) => SessionDto(
  id: id,
  backendKey: 'codex',
  title: title,
  model: 'gpt-test',
  status: 'idle',
  tokens: TokensDto(),
);

Envelope _message({required int sessionId, required String role, int ts = 1}) =>
    Envelope(
      protocolVersion: 'v1',
      schemaVersion: 1,
      sessionId: sessionId,
      ts: ts,
      type: 'message',
      payload: {'id': '$sessionId-$ts', 'role': role, 'text': 'message'},
    );

class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.responses)
    : super(
        Endpoint(
          serverUrl: 'http://127.0.0.1:47870',
          token: 'test-token',
          deviceId: 'test-device',
          deviceName: 'Test desktop',
        ),
      );

  final List<List<SessionDto>> responses;
  int calls = 0;

  @override
  Future<List<SessionDto>> listSessions() async {
    final index = calls < responses.length ? calls : responses.length - 1;
    calls++;
    return responses[index];
  }
}

void main() {
  test('authoritative snapshot replaces an empty cached title', () {
    final merged = mergeSessionSnapshot([
      _session(id: 7, title: ''),
    ], _session(id: 7, title: 'mobile title 已同步'));

    expect(merged, hasLength(1));
    expect(merged.single.title, 'mobile title 已同步');
  });

  test('authoritative snapshot inserts a previously unknown session', () {
    final merged = mergeSessionSnapshot([
      _session(id: 7, title: 'existing'),
    ], _session(id: 8, title: 'new'));

    expect(merged.map((session) => session.id), [7, 8]);
  });

  test('session.updated replaces the cached DTO in the provider', () async {
    final api = _FakeApiClient([
      [_session(id: 7, title: '')],
    ]);
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    await container.read(sessionsProvider.future);
    events.add(
      Envelope(
        protocolVersion: 'v1',
        schemaVersion: 1,
        sessionId: 7,
        ts: 1,
        type: 'session.updated',
        payload: {
          'id': 7,
          'backend_key': 'codex',
          'title': 'updated live',
          'model': 'gpt-test',
          'status': 'idle',
          'tokens': <String, int>{},
        },
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(
      container.read(sessionsProvider).valueOrNull!.single.title,
      'updated live',
    );
  });

  test('connection.hello refreshes an authoritative title', () async {
    final api = _FakeApiClient([
      [_session(id: 7, title: '')],
      [_session(id: 7, title: 'refreshed after reconnect')],
    ]);
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    await container.read(sessionsProvider.future);
    events.add(
      Envelope(
        protocolVersion: 'v1',
        schemaVersion: 1,
        sessionId: 0,
        ts: 1,
        type: 'connection.hello',
        payload: const {},
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(api.calls, 2);
    expect(
      container.read(sessionsProvider).valueOrNull!.single.title,
      'refreshed after reconnect',
    );
  });

  test('unread counts ignore user messages and clear while viewing', () async {
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [eventStreamProvider.overrideWith((ref) => events.stream)],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    container.read(sessionUnreadCountProvider);
    events
      ..add(_message(sessionId: 7, role: 'user'))
      ..add(_message(sessionId: 7, role: 'assistant', ts: 2));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(container.read(sessionUnreadCountProvider), {7: 1});

    container.read(sessionUnreadCountProvider.notifier).viewSession(7);
    events.add(_message(sessionId: 7, role: 'assistant', ts: 3));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(container.read(sessionUnreadCountProvider), isEmpty);

    container.read(sessionUnreadCountProvider.notifier).leaveSession(7);
    events.add(_message(sessionId: 7, role: 'assistant', ts: 4));
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(container.read(sessionUnreadCountProvider), {7: 1});
  });

  test('unread count caps at the 99+ sentinel', () async {
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [eventStreamProvider.overrideWith((ref) => events.stream)],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    container.read(sessionUnreadCountProvider);
    for (var i = 0; i < 105; i++) {
      events.add(_message(sessionId: 7, role: 'assistant', ts: i));
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(container.read(sessionUnreadCountProvider), {7: 100});
  });

  testWidgets('session row renders the capped 99+ unread badge', (
    tester,
  ) async {
    final api = _FakeApiClient([
      [_session(id: 7, title: 'Unread session')],
    ]);
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: KillLaTheme.light(),
          home: const SessionsScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    for (var i = 0; i < 105; i++) {
      events.add(_message(sessionId: 7, role: 'assistant', ts: i));
    }
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('99+'), findsOneWidget);
    expect(
      find.bySemanticsLabel(RegExp(r'99\+ unread messages')),
      findsOneWidget,
    );
  });
}
