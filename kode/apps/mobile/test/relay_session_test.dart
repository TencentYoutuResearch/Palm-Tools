import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/account_client.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/storage/account_storage.dart';

String _jwt(String sub, int exp) {
  String b64(Object v) =>
      base64Url.encode(utf8.encode(jsonEncode(v))).replaceAll('=', '');
  return '${b64({'alg': 'HS256'})}.${b64({'sub': sub, 'exp': exp})}.sig';
}

/// A relay that issues per-device sessions; `sessions` false makes it an
/// older relay that answers 404 on the session routes.
class SessionRelay {
  SessionRelay._(this._server);

  final HttpServer _server;
  final requests = <String, List<HttpRequest>>{};
  final bodies = <String, Map<String, dynamic>>{};
  bool sessions = true;
  int generation = 0;

  String get url => 'http://${_server.address.host}:${_server.port}';
  int count(String path) => requests[path]?.length ?? 0;

  static Future<SessionRelay> start() async {
    final relay = SessionRelay._(
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
    );
    relay._server.listen(relay._handle);
    return relay;
  }

  Map<String, dynamic> _issued() {
    final exp = DateTime.now().millisecondsSinceEpoch ~/ 1000 + 3600;
    return {
      'token_issuer': 'relay',
      'access_token': _jwt('alice', exp),
      'refresh_token': 'kr1.s.$generation',
      'expires_in': 3600,
      'sub': 'alice',
      'session_id': 's',
      'profile': {'name': 'marx', 'picture': '', 'email': ''},
    };
  }

  Future<void> _handle(HttpRequest request) async {
    final path = request.uri.path;
    (requests[path] ??= []).add(request);
    final raw = await utf8.decodeStream(request);
    if (raw.isNotEmpty) bodies[path] = jsonDecode(raw) as Map<String, dynamic>;
    request.response.headers.contentType = ContentType.json;
    var status = 200;
    Object body;
    switch (path) {
      case '/api/v1/healthz':
        body = {'server_kind': 'kode-relay', 'issuer': url, 'sessions': sessions};
      case '/api/v1/auth/palm':
        body = sessions
            ? _issued()
            : {
                'access_token': _jwt('alice', 9999999999),
                'refresh_token': 'cb-refresh',
                'expires_in': 7200,
                'sub': 'alice',
              };
      case '/api/v1/auth/session' || '/api/v1/auth/token' when !sessions:
        status = 404;
        body = {'error': 'not_found', 'detail': 'no sessions'};
      case '/api/v1/auth/session':
        body = _issued();
      case '/api/v1/auth/token':
        if (bodies[path]?['refresh_token'] != 'kr1.s.$generation') {
          status = 401;
          body = {'error': 'unauthorized', 'detail': 'invalid token'};
        } else {
          // Slow enough that concurrent callers would overlap.
          await Future<void>.delayed(const Duration(milliseconds: 100));
          generation++;
          body = _issued();
        }
      default:
        status = 404;
        body = {'error': 'not_found'};
    }
    request.response.statusCode = status;
    await (request.response..write(jsonEncode(body))).close();
  }

  Future<void> close() => _server.close(force: true);
}

class MemoryAccountStorage extends AccountStorage {
  AccountSession? saved;

  @override
  Future<AccountSession?> load() async => saved;

  @override
  Future<void> save(AccountSession session) async => saved = session;

  @override
  Future<void> clear() async => saved = null;
}

AccountClient _client() => AccountClient(
  deviceId: () async => 'phone-install-0001',
  deviceName: () async => '黑钛机',
);

void main() {
  test('palm sign-in asks for a relay session for this phone', () async {
    final relay = await SessionRelay.start();
    addTearDown(relay.close);
    final session = await _client().palmSignIn(relay.url, 'ses_1');
    final request = relay.requests['/api/v1/auth/palm']!.single;
    expect(request.headers.value('x-kode-session'), 'relay');
    expect(request.headers.value('x-device-id'), 'phone-install-0001');
    expect(
      Uri.decodeComponent(request.headers.value('x-kode-device-name')!),
      '黑钛机',
    );
    expect(session.relaySession, isTrue);
    expect(session.name, 'marx');
    expect(session.refreshToken, 'kr1.s.0');
    expect(AccountSession.fromJson(session.toJson()).relaySession, isTrue);
  });

  test('relay sessions refresh at the relay, never at CloudBase', () async {
    final relay = await SessionRelay.start();
    addTearDown(relay.close);
    final client = _client();
    final session = await client.palmSignIn(relay.url, 'ses_1');
    final next = await client.refresh(session);
    expect(relay.count('/api/v1/auth/token'), 1);
    expect(relay.count('/auth/v1/token'), 0);
    expect(next.refreshToken, 'kr1.s.1');
    expect(next.relaySession, isTrue);
    await expectLater(
      client.refresh(session),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
      reason: 'a rotated refresh token is spent',
    );
  });

  test('older relays keep CloudBase sessions', () async {
    final relay = await SessionRelay.start()..sessions = false;
    addTearDown(relay.close);
    final client = _client();
    final session = await client.palmSignIn(relay.url, 'ses_1');
    expect(session.relaySession, isFalse);
    expect(await client.upgrade(session), isNull);
  });

  test('a saved CloudBase session moves to a relay session once', () async {
    final relay = await SessionRelay.start();
    addTearDown(relay.close);
    final storage = MemoryAccountStorage()
      ..saved = AccountSession(
        serverUrl: relay.url,
        issuer: relay.url,
        email: '',
        method: LoginMethod.palm,
        userId: 'alice',
        accessToken: 'cb-access',
        refreshToken: 'cb-refresh',
        expiresAt: DateTime.now()
            .add(const Duration(hours: 1))
            .millisecondsSinceEpoch,
      );
    final container = ProviderContainer(
      overrides: [
        accountClientProvider.overrideWithValue(_client()),
        accountStorageProvider.overrideWithValue(storage),
      ],
    );
    addTearDown(container.dispose);
    final notifier = container.read(accountProvider.notifier);
    final session = await notifier.restore();
    expect(session!.relaySession, isTrue);
    expect(relay.bodies['/api/v1/auth/session']!['provider_token'], 'cb-access');
    expect(storage.saved!.refreshToken, 'kr1.s.0');
    await notifier.ensureFresh();
    expect(relay.count('/api/v1/auth/session'), 1);
  });

  test('concurrent callers share one refresh', () async {
    final relay = await SessionRelay.start();
    addTearDown(relay.close);
    final client = _client();
    final signedIn = await client.palmSignIn(relay.url, 'ses_1');
    final storage = MemoryAccountStorage()
      ..saved = signedIn.copyWith(expiresAt: 1);
    final container = ProviderContainer(
      overrides: [
        accountClientProvider.overrideWithValue(client),
        accountStorageProvider.overrideWithValue(storage),
      ],
    );
    addTearDown(container.dispose);
    final notifier = container.read(accountProvider.notifier);
    container.read(accountProvider.notifier).state = storage.saved;
    final results = await Future.wait([
      notifier.ensureFresh(),
      notifier.ensureFresh(),
      notifier.ensureFresh(),
    ]);
    expect(relay.count('/api/v1/auth/token'), 1);
    expect(results.map((s) => s!.refreshToken).toSet(), {'kr1.s.1'});
    expect(container.read(accountProvider)!.refreshToken, 'kr1.s.1');
  });
}
