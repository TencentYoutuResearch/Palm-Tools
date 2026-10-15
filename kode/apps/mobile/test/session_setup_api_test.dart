import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  test(
    'catalogue, directories and creation preserve desktop contract and retry key',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final posts = <Map<String, dynamic>>[];
      final keys = <String?>[];
      final subscription = server.listen((req) async {
        req.response.headers.contentType = ContentType.json;
        var body = <String, dynamic>{};
        switch (req.uri.path) {
          case '/healthz':
            break;
          case '/api/v1/backends':
            body = {
              'home': '/workspace',
              'backends': [
                {
                  'key': 'custom',
                  'display_name': 'Custom',
                  'model_flag': '--model',
                },
                {'key': 'disabled', 'enabled': false},
              ],
            };
          case '/api/v1/backends/custom/models':
            body = {
              'custom_allowed': false,
              'models': [
                {'id': 'm1', 'label': 'Model 1'},
              ],
            };
          case '/api/v1/fs/list':
            expect(req.uri.queryParameters['path'], '/workspace/中文 project');
            expect(req.uri.queryParameters['show_hidden'], 'true');
            body = {
              'path': '/workspace/中文 project',
              'parent': '/workspace',
              'entries': [
                {
                  'name': 'src',
                  'path': '/workspace/中文 project/src',
                  'is_dir': true,
                },
                {'name': 'file', 'path': '/workspace/file', 'is_dir': false},
              ],
            };
          case '/api/v1/sessions':
            posts.add(
              jsonDecode(await utf8.decoder.bind(req).join())
                  as Map<String, dynamic>,
            );
            keys.add(req.headers.value('Idempotency-Key'));
            if (posts.length == 1) {
              req.response.statusCode = 202;
              body = {'detail': 'Still pending'};
            } else {
              body = {
                'id': 8,
                'backend_key': 'custom',
                'model': 'm1',
                'cwd': '/workspace',
              };
            }
        }
        req.response.write(jsonEncode(body));
        await req.response.close();
      });
      try {
        final api = ApiClient(
          Endpoint(
            serverUrl: 'http://${server.address.host}:${server.port}',
            token: 'test',
            deviceId: 'desktop',
            deviceName: 'Desktop',
          ),
        );
        expect((await api.listBackends()).backends.single.key, 'custom');
        expect((await api.listModels('custom')).customAllowed, isFalse);
        expect(
          (await api.listDirectories(
            path: '/workspace/中文 project',
            showHidden: true,
          )).entries.single.name,
          'src',
        );
        Future<SessionDto> create() => api.createSession(
          backendKey: 'custom',
          cwd: '/workspace',
          model: 'm1',
          requestId: 'same-key',
        );
        await expectLater(
          create(),
          throwsA(
            isA<ApiException>().having(
              (error) => error.error,
              'error',
              'creation_unconfirmed',
            ),
          ),
        );
        expect((await create()).id, 8);
        expect(posts[0], {
          'backend_key': 'custom',
          'cwd': '/workspace',
          'model': 'm1',
        });
        expect(posts[1], posts[0]);
        expect(keys, ['same-key', 'same-key']);
      } finally {
        await subscription.cancel();
        await server.close(force: true);
      }
    },
  );
}
