import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';

SessionDto _session({required int id, required String title}) => SessionDto(
  id: id,
  backendKey: 'codex',
  title: title,
  model: 'gpt-test',
  status: 'idle',
  tokens: TokensDto(),
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
}
