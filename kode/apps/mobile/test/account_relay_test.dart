import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/account_client.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/palm/palm_capture_screen.dart';

/// A loopback stand-in for the relay plus its sign-in provider.
class FakeRelay {
  FakeRelay._(this._server);

  final HttpServer _server;
  final requests = <HttpRequest>[];
  final bodies = <String, Map<String, dynamic>>{};
  bool knownUser = true;

  /// Answer palm sign-in as an already-used scan.
  bool palmReplayed = false;

  String get url => 'http://${_server.address.host}:${_server.port}';

  static Future<FakeRelay> start() async {
    final relay = FakeRelay._(
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
    );
    relay._server.listen(relay._handle);
    return relay;
  }

  Future<void> _handle(HttpRequest request) async {
    requests.add(request);
    final raw = await utf8.decodeStream(request);
    if (raw.isNotEmpty) {
      bodies[request.uri.path] = jsonDecode(raw) as Map<String, dynamic>;
    }
    request.response.headers.contentType = ContentType.json;
    if (palmReplayed && request.uri.path == '/api/v1/auth/palm') {
      request.response.statusCode = 409;
      await (request.response..write(
            jsonEncode({'error': 'conflict', 'detail': 'already used'}),
          ))
          .close();
      return;
    }
    final Object body = switch (request.uri.path) {
      '/api/v1/healthz' => {
        'status': 'ok',
        'server_kind': 'kode-relay',
        'issuer': url,
        'login_methods': [
          {'id': 'palm', 'app_id': 'app_test', 'sdk_url': '$url/loader.js'},
          {'id': 'email'},
          {'id': 'future_method'},
        ],
      },
      '/auth/v1/verification' => {
        'verification_id': 'ver-1',
        'expires_in': 600,
        'is_user': knownUser,
      },
      '/auth/v1/verification/verify' => {'verification_token': 'vt-1'},
      '/auth/v1/signin' || '/auth/v1/signup' => {
        'access_token': 'access-1',
        'refresh_token': 'refresh-1',
        'expires_in': 3600,
        'sub': 'user-1',
      },
      '/auth/v1/token' => {'access_token': 'access-2', 'expires_in': 3600},
      '/api/v1/account/devices' => {
        'devices': [
          {'device_id': 'desk-1', 'name': 'Studio', 'online': true},
        ],
      },
      '/api/v1/sessions' => {'sessions': []},
      '/api/v1/auth/palm' => {
        'access_token': 'palm1n-access',
        'refresh_token': 'palm1n-refresh',
        'expires_in': 7200,
        'sub': '1234567890',
        'provider': 'palm',
      },
      '/api/v1/palm/enroll_token' => {
        'token': 'sut_x',
        'user_id': '1234567890',
        'app_id': 'app_test',
      },
      '/api/v1/palm' => {
        'enrolled': request.method == 'GET',
        'sides': request.method == 'GET' ? [2] : [],
      },
      final path when path.endsWith('/approve') => {'state': 'approved'},
      '/api/v1/auth/palm/register' => {
        'registration_id': 'reg-1',
        'secret': 'sec-1',
        'user_id': 'pl_new',
        'token': 'sut_new',
        'app_id': 'app_test',
        'expires_in': 600,
      },
      '/api/v1/auth/palm/register/finish' => {
        'access_token': 'new-access',
        'refresh_token': 'new-refresh',
        'expires_in': 7200,
        'sub': 'pl_new',
        'provider': 'palm',
      },
      _ => {'error': 'not_found'},
    };
    await (request.response..write(jsonEncode(body))).close();
  }

  HttpRequest last(String path) =>
      requests.lastWhere((request) => request.uri.path == path);

  Future<void> close() => _server.close(force: true);
}

void main() {
  test('relay endpoints name the desktop on sockets and requests', () async {
    final relay = Endpoint(
      serverUrl: 'https://relay.example.com/',
      token: 't',
      deviceId: 'desk-1',
      deviceName: 'Studio',
      serverKind: Endpoint.relayKind,
    );
    expect(relay.wsUrl, 'wss://relay.example.com/ws?device_id=desk-1');
    final paired = Endpoint(
      serverUrl: 'https://sync.example.com',
      token: 't',
      deviceId: 'dev',
      deviceName: 'Home',
      serverKind: 'kode-sync-server',
    );
    expect(paired.wsUrl, 'wss://sync.example.com/ws');

    final server = await FakeRelay.start();
    addTearDown(server.close);
    final client = ApiClient(
      Endpoint(
        serverUrl: server.url,
        token: 'access-1',
        deviceId: 'desk-1',
        deviceName: 'Studio',
        serverKind: Endpoint.relayKind,
      ),
    );
    await client.listSessions();
    final request = server.last('/api/v1/sessions');
    expect(request.headers.value(relayDeviceHeader), 'desk-1');
    expect(request.headers.value('authorization'), 'Bearer access-1');
  });

  test(
    'email sign-in follows the relay issuer and creates new accounts',
    () async {
      final server = await FakeRelay.start();
      addTearDown(server.close);
      final client = AccountClient();

      final pending = await client.sendCode(
        '${server.url}/',
        ' me@example.com ',
      );
      expect(pending.serverUrl, server.url);
      expect(pending.issuer, server.url);
      expect(server.bodies['/auth/v1/verification'], {
        'email': 'me@example.com',
        'target': 'ANY',
      });

      final session = await client.signIn(pending, ' 123456 ');
      expect(server.bodies['/auth/v1/verification/verify'], {
        'verification_id': 'ver-1',
        'verification_code': '123456',
      });
      expect(
        server.requests.any((r) => r.uri.path == '/auth/v1/signin'),
        isTrue,
      );
      expect(session.userId, 'user-1');
      expect(session.accessToken, 'access-1');

      server.knownUser = false;
      await client.signIn(
        await client.sendCode(server.url, 'new@example.com'),
        '1',
      );
      expect(server.bodies['/auth/v1/signup']?['email'], 'new@example.com');

      final refreshed = await client.refresh(session);
      expect(server.bodies['/auth/v1/token'], {
        'grant_type': 'refresh_token',
        'refresh_token': 'refresh-1',
      });
      expect(refreshed.accessToken, 'access-2');
      expect(refreshed.refreshToken, 'refresh-1', reason: 'not rotated');

      final devices = await client.devices(session);
      expect(devices.single.deviceId, 'desk-1');
      expect(
        server.last('/api/v1/account/devices').headers.value('authorization'),
        'Bearer access-1',
      );
      expect(session.endpointFor(devices.single).isRelay, isTrue);
    },
  );

  test('servers that are not relays or lack TLS are refused', () async {
    expect(trustedIssuer('https://env.api.example.com'), isTrue);
    expect(trustedIssuer('http://127.0.0.1:8080'), isTrue);
    expect(trustedIssuer('http://id.example.com'), isFalse);

    final plain = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => plain.close(force: true));
    plain.listen((request) async {
      request.response.headers.contentType = ContentType.json;
      await (request.response..write(jsonEncode({'status': 'ok'}))).close();
    });
    await expectLater(
      AccountClient().relayIssuer('http://127.0.0.1:${plain.port}'),
      throwsA(isA<ApiException>()),
    );
  });

  test('refresh timing and unverified subject parsing', () {
    final now = DateTime.fromMillisecondsSinceEpoch(1000000);
    AccountSession expiringAt(Duration fromNow) => AccountSession(
      serverUrl: 'https://relay.example.com',
      issuer: 'https://id.example.com',
      email: 'a@example.com',
      userId: 'u',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: now.add(fromNow).millisecondsSinceEpoch,
    );
    expect(expiringAt(const Duration(minutes: 30)).needsRefresh(now), isFalse);
    expect(expiringAt(const Duration(minutes: 2)).needsRefresh(now), isTrue);

    final payload = base64Url
        .encode(utf8.encode('{"sub":"user-9"}'))
        .replaceAll('=', '');
    expect(jwtSubject('h.$payload.s'), 'user-9');
    expect(jwtSubject('nope'), isNull);
  });

  test('relay sockets close in the background but QR bindings stay', () {
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final relay = Endpoint(
      serverUrl: 'http://127.0.0.1:9',
      token: 't',
      deviceId: 'desk-1',
      deviceName: 'Studio',
      serverKind: Endpoint.relayKind,
    );
    container.read(endpointProvider.notifier).state = relay;
    expect(container.read(wsClientProvider), isNotNull);

    container.read(appForegroundProvider.notifier).state = false;
    expect(container.read(wsClientProvider), isNull);

    container.read(endpointProvider.notifier).state = relay.copyWith(
      serverKind: 'kode-sync-server',
    );
    expect(container.read(wsClientProvider), isNotNull);
  });

  test('relays list sign-in methods; unknown ones are ignored', () async {
    final server = await FakeRelay.start();
    addTearDown(server.close);
    expect(await AccountClient().loginMethods(server.url), [
      LoginMethod.palm,
      LoginMethod.email,
    ]);
    expect(AccountClient.parseLoginMethods(const {}), [LoginMethod.email]);
  });

  test('sessions saved before login methods read back as email', () {
    final legacy = AccountSession.fromJson({
      'server_url': 'https://relay.example.com',
      'issuer': 'https://id.example.com',
      'email': 'a@example.com',
      'user_id': 'u',
      'access_token': 'a',
      'refresh_token': 'r',
      'expires_at': 1,
    });
    expect(legacy.method, LoginMethod.email);
    // Retired PalmX sessions still load; labels never name the method.
    final old = AccountSession.fromJson({
      ...legacy.toJson(),
      'email': null,
      'method': 'palmx',
      'user_id': 'px_abcd1234',
    });
    expect(old.label, 'Kode · 1234');
    final named = AccountSession.fromJson({...old.toJson(), 'name': 'Ada'});
    expect(named.label, 'Ada');
    expect(
      applyProfile(old, {
        'name': 'Ada',
        'picture': 'http://x.example/a.png',
      }).picture,
      '',
      reason: 'plain-http avatars are dropped',
    );
  });

  group('palm 1:N', () {
    test('capture URL carries mode, app and enrol token', () async {
      final server = await FakeRelay.start();
      addTearDown(server.close);
      final config = await AccountClient().palmConfig(server.url);
      expect(config.appId, 'app_test');
      final recognise = config.captureUri();
      expect(recognise.path, '/palm/capture');
      expect(recognise.queryParameters['mode'], 'recognition');
      expect(recognise.queryParameters.containsKey('token'), isFalse);
      final enrol = config.captureUri(
        mode: 'registration',
        token: 'sut_x',
        userId: 'u1',
      );
      expect(enrol.queryParameters['token'], 'sut_x');
      expect(enrol.queryParameters['user_id'], 'u1');
    });

    test('a capture session signs in as the matched account', () async {
      final server = await FakeRelay.start();
      addTearDown(server.close);
      final session = await AccountClient().palmSignIn(server.url, 'ses_1');
      expect(server.bodies['/api/v1/auth/palm'], {'session_id': 'ses_1'});
      expect(session.method, LoginMethod.palm);
      expect(session.userId, '1234567890');
      expect(session.label, 'Kode · 7890');
      expect(
        AccountSession.fromJson(session.toJson()).method,
        LoginMethod.palm,
      );
    });

    test('palm sign-up enrols the minted id and signs it in', () async {
      final server = await FakeRelay.start();
      addTearDown(server.close);
      final client = AccountClient();
      final registration = await client.palmRegisterStart(server.url);
      expect(registration.userId, 'pl_new');
      expect(registration.token, 'sut_new');
      final session = await client.palmRegisterFinish(registration, 'ses_r');
      expect(server.bodies['/api/v1/auth/palm/register/finish'], {
        'registration_id': 'reg-1',
        'secret': 'sec-1',
        'session_id': 'ses_r',
      });
      expect(session.userId, 'pl_new');
      expect(session.method, LoginMethod.palm);
    });

    test('a replayed scan surfaces the relay conflict', () async {
      final server = await FakeRelay.start()
        ..palmReplayed = true;
      addTearDown(server.close);
      await expectLater(
        AccountClient().palmSignIn(server.url, 'ses_1'),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 409)),
      );
    });

    test('enrolment calls carry the account token', () async {
      final server = await FakeRelay.start();
      addTearDown(server.close);
      final client = AccountClient();
      final session = await client.palmSignIn(server.url, 'ses_1');
      expect(await client.palmEnrollToken(session), 'sut_x');
      expect(
        server.last('/api/v1/palm/enroll_token').headers.value('authorization'),
        'Bearer palm1n-access',
      );
      expect(await client.palmEnrolled(session), isTrue);
      await client.forgetPalm(session);
      expect(server.last('/api/v1/palm').method, 'DELETE');
    });

    test('desktop handoff QR is parsed and approved', () async {
      final server = await FakeRelay.start();
      addTearDown(server.close);
      final handoff = PalmHandoff.tryParse(
        'kode://palm-login?relay=${Uri.encodeComponent(server.url)}&id=h1',
      )!;
      expect(handoff.id, 'h1');
      await AccountClient().approveHandoff(handoff, 'ses_2');
      expect(server.bodies['/api/v1/auth/palm/handoff/h1/approve'], {
        'session_id': 'ses_2',
      });
      expect(
        PalmHandoff.tryParse(
          'kode://palm-login?relay=http://evil.example&id=1',
        ),
        isNull,
      );
      expect(PalmHandoff.tryParse('kode://pair?x=1'), isNull);
    });

    test('capture results parse from both channels', () {
      const json =
          '{"code":0,"message":"ok","data":{"sessionId":"s1","userId":"x"}}';
      final direct = parseCaptureMessage(json)!;
      expect(direct.ok, isTrue);
      expect(direct.sessionId, 's1');
      final viaUrl = parseCaptureMessage(
        'kodepalm://result#${Uri.encodeComponent(json)}',
      )!;
      expect(viaUrl.sessionId, 's1');
      final miss = parseCaptureMessage('{"code":10200,"message":"no match"}')!;
      expect(miss.ok, isFalse);
      expect(miss.friendly, contains('No account matches'));
      expect(parseCaptureMessage('garbage'), isNull);
    });

    test('iOS palm support starts at 16.4', () {
      expect(iosSupportsPalm('16.3.1'), isFalse);
      expect(iosSupportsPalm('16.4'), isTrue);
      expect(iosSupportsPalm('17.0'), isTrue);
      expect(iosSupportsPalm('15.8'), isFalse);
    });
  });
}
