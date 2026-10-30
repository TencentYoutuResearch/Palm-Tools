import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  for (final operation in ['model', 'mode']) {
    for (final outcome in ['executed', 'failed']) {
      test(
        '$operation switch waits for the desktop $outcome receipt',
        () async {
          final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
          var receipts = 0;
          final subscription = server.listen((req) async {
            req.response.headers.contentType = ContentType.json;
            Object body = {};
            if (req.uri.path.endsWith('/$operation')) {
              expect(req.headers.value('Idempotency-Key'), isNotEmpty);
              expect(jsonDecode(await utf8.decoder.bind(req).join()), {
                operation: operation == 'model' ? 'new-model' : 'reviewed',
              });
              req.response.statusCode = 202;
              body = {
                'command_id': 'change-1',
                'status': 'accepted',
                'mode': 'reviewed',
              };
            } else if (req.uri.path.endsWith('/history')) {
              receipts++;
              body = {
                'events': [
                  {
                    'type': 'command.status',
                    'session_id': 8,
                    'ts': 1,
                    'payload': {
                      'command_id': 'change-1',
                      'status': outcome,
                      'error': 'not supported',
                    },
                  },
                ],
              };
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
            if (outcome == 'executed') {
              if (operation == 'model') {
                await api.setModel(8, 'new-model');
              } else {
                expect(await api.setMode(8, 'reviewed'), 'reviewed');
              }
            } else {
              await expectLater(
                operation == 'model'
                    ? api.setModel(8, 'new-model')
                    : api.setMode(8, 'reviewed'),
                throwsA(isA<ApiException>()),
              );
            }
            expect(receipts, 1);
          } finally {
            await subscription.cancel();
            await server.close(force: true);
          }
        },
      );
    }
  }
}
