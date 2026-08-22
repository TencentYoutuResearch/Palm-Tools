import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/api/gateway_session.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  test('validates the namespaced sync-server health response', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requestedPaths = <String>[];
    final subscription = server.listen((request) async {
      requestedPaths.add(request.uri.path);
      request.response.headers.contentType = ContentType.json;
      if (request.uri.path == '/api/v1/healthz') {
        request.response.write(jsonEncode({'status': 'ok', 'version': 'test'}));
      } else {
        request.response.write('ok');
      }
      await request.response.close();
    });

    try {
      final baseUrl = 'http://${server.address.host}:${server.port}';
      final client = ApiClient(
        Endpoint(
          serverUrl: baseUrl,
          token: 'mobile-token',
          deviceId: 'device-1',
          deviceName: 'Test Desktop',
        ),
      );

      expect(await client.healthz(), isTrue);
      expect(requestedPaths, contains('/healthz'));
      expect(requestedPaths, contains('/api/v1/healthz'));
    } finally {
      await subscription.cancel();
      await server.close(force: true);
    }
  });

  test('performs cookie challenge before the first API request', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var healthRequests = 0;
    var claimRequests = 0;
    final subscription = server.listen((request) async {
      final hasCookie = request.cookies.any(
        (cookie) => cookie.name == 'aio_access' && cookie.value == 'granted',
      );
      if (request.uri.path == '/healthz') {
        healthRequests++;
        if (!hasCookie) {
          request.response.cookies.add(Cookie('aio_access', 'granted'));
          request.response.statusCode = HttpStatus.forbidden;
        } else {
          request.response.write('ok');
        }
      } else if (request.uri.path == '/api/v1/pairings/pair_1/claim') {
        claimRequests++;
        request.response.statusCode = hasCookie
            ? HttpStatus.ok
            : HttpStatus.forbidden;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({'paired': hasCookie}));
      } else {
        request.response.statusCode = HttpStatus.notFound;
      }
      await request.response.close();
    });

    try {
      final baseUrl = 'http://${server.address.host}:${server.port}';
      final session = GatewaySession.forServer(baseUrl);
      final dio = session.createDio(
        BaseOptions(baseUrl: baseUrl, validateStatus: (_) => true),
      );

      final response = await dio.post('/api/v1/pairings/pair_1/claim');

      expect(response.statusCode, HttpStatus.ok);
      expect(response.data['paired'], isTrue);
      expect(healthRequests, 2);
      expect(claimRequests, 1);
      expect(
        await session.websocketHeaders('mobile-token'),
        containsPair(HttpHeaders.cookieHeader, 'aio_access=granted'),
      );
    } finally {
      await subscription.cancel();
      await server.close(force: true);
    }
  });

  test('retries a safe API read after an AIO cookie rotation', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var sessionRequests = 0;
    final subscription = server.listen((request) async {
      final hasCookie = request.cookies.any(
        (cookie) => cookie.name == 'aio_access' && cookie.value == 'rotated',
      );
      if (request.uri.path == '/healthz') {
        request.response.write('ok');
      } else if (request.uri.path == '/api/v1/sessions') {
        sessionRequests++;
        request.response.headers.contentType = ContentType.json;
        if (!hasCookie) {
          request.response.statusCode = HttpStatus.forbidden;
          request.response.headers.set('x-proxy-by', 'aio-forward');
          request.response.cookies.add(Cookie('aio_access', 'rotated'));
          request.response.write(jsonEncode({'error': 'forbidden'}));
        } else {
          request.response.write(
            jsonEncode({
              'sessions': [
                {
                  'id': 7,
                  'backend_key': 'codex',
                  'title': 'synced',
                  'model': 'auto',
                  'status': 'busy',
                  'tokens': <String, int>{},
                },
              ],
            }),
          );
        }
      } else {
        request.response.statusCode = HttpStatus.notFound;
      }
      await request.response.close();
    });

    try {
      final baseUrl = 'http://${server.address.host}:${server.port}';
      final client = ApiClient(
        Endpoint(
          serverUrl: baseUrl,
          token: 'mobile-token',
          deviceId: 'device-1',
          deviceName: 'Test Desktop',
        ),
      );

      final sessions = await client.listSessions();

      expect(sessions, hasLength(1));
      expect(sessions.single.title, 'synced');
      expect(sessionRequests, 2);
    } finally {
      await subscription.cancel();
      await server.close(force: true);
    }
  });
}
