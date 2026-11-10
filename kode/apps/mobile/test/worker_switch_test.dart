import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  test(
    'selected monitor Worker is sent for catalogue and session reads',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final selectedHeaders = <String?>[];
      final subscription = server.listen((request) async {
        selectedHeaders.add(request.headers.value('x-kode-worker-id'));
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path == '/api/v1/workers') {
          request.response.write(
            jsonEncode({
              'workers': [
                {
                  'worker_id': 'worker-a',
                  'name': 'Office Mac',
                  'online': true,
                  'last_seen_at': 1,
                  'kode_version': '0.2.2',
                  'os': 'macos',
                  'arch': 'arm64',
                  'inventory_capable': true,
                  'bound': true,
                },
                {
                  'worker_id': 'worker-b',
                  'name': 'Lab PC',
                  'online': true,
                  'last_seen_at': 2,
                  'kode_version': '0.2.2',
                  'os': 'linux',
                  'arch': 'x86_64',
                  'inventory_capable': true,
                  'bound': false,
                },
              ],
            }),
          );
        } else {
          request.response.write(jsonEncode({'sessions': []}));
        }
        await request.response.close();
      });

      try {
        final endpoint = Endpoint(
          serverUrl: 'http://${server.address.host}:${server.port}',
          token: 'mobile-token',
          deviceId: 'worker-a',
          deviceName: 'Office Mac',
          workerId: 'worker-b',
          workerName: 'Lab PC',
        );
        final api = ApiClient(endpoint);
        final workers = await api.listWorkers();
        await api.listSessions();

        expect(workers.map((worker) => worker.workerId), [
          'worker-a',
          'worker-b',
        ]);
        expect(workers[1].name, 'Lab PC');
        expect(selectedHeaders.whereType<String>(), ['worker-b', 'worker-b']);
      } finally {
        await subscription.cancel();
        await server.close(force: true);
      }
    },
  );

  test('endpoint keeps the bound Worker when the monitor target changes', () {
    final endpoint = Endpoint(
      serverUrl: 'https://sync.example.com',
      token: 'token',
      deviceId: 'bound-worker',
      deviceName: 'Bound Worker',
    ).copyWith(workerId: 'monitor-worker', workerName: 'Monitor Worker');

    expect(endpoint.storageKey, 'https://sync.example.com::bound-worker');
    expect(endpoint.activeWorkerId, 'monitor-worker');
    expect(endpoint.activeWorkerName, 'Monitor Worker');
    expect(Endpoint.fromJson(endpoint.toJson()).workerId, 'monitor-worker');
  });
}
