import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/storage/endpoint_storage.dart';
import 'package:kode_mobile/src/ui/devices/workers_screen.dart';

void main() {
  testWidgets('Worker selector persists the selected monitor target', (
    tester,
  ) async {
    final endpoint = Endpoint(
      serverUrl: 'https://sync.example.com',
      token: 'token',
      deviceId: 'worker-a',
      deviceName: 'Office Mac',
    );
    final workers = [
      const WorkerDto(
        workerId: 'worker-a',
        name: 'Office Mac',
        online: true,
        lastSeenAt: 1,
        kodeVersion: '0.2.2',
        os: 'macos',
        arch: 'arm64',
        inventoryCapable: true,
        bound: true,
      ),
      const WorkerDto(
        workerId: 'worker-b',
        name: 'Lab PC',
        online: true,
        lastSeenAt: 2,
        kodeVersion: '0.2.2',
        os: 'linux',
        arch: 'x86_64',
        inventoryCapable: true,
        bound: false,
      ),
    ];
    final storage = _MemoryEndpointStorage(
      EndpointCollection(endpoints: [endpoint], activeKey: endpoint.storageKey),
    );
    final container = ProviderContainer(
      overrides: [
        endpointProvider.overrideWith((ref) => endpoint),
        savedEndpointsProvider.overrideWith((ref) => [endpoint]),
        endpointStorageProvider.overrideWithValue(storage),
        workersProvider.overrideWith((ref) async => workers),
      ],
    );
    addTearDown(container.dispose);
    final router = GoRouter(
      initialLocation: '/workers',
      routes: [
        GoRoute(path: '/workers', builder: (_, _) => const WorkersScreen()),
        GoRoute(
          path: '/sessions',
          builder: (_, _) => const Scaffold(body: Text('sessions')),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Lab PC'));
    await tester.pumpAndSettle();

    expect(container.read(endpointProvider)?.activeWorkerId, 'worker-b');
    expect(container.read(endpointProvider)?.activeWorkerName, 'Lab PC');
    expect(storage.saved.activeWorkerId, 'worker-b');
    expect(find.text('sessions'), findsOneWidget);
  });
}

class _MemoryEndpointStorage extends EndpointStorage {
  _MemoryEndpointStorage(this.collection);

  EndpointCollection collection;

  Endpoint get saved => collection.active!;

  @override
  Future<EndpointCollection> loadCollection() async => collection;

  @override
  Future<void> save(Endpoint endpoint) async {
    collection = collection.upsert(endpoint);
  }

  @override
  Future<void> activate(String key) async {
    collection = collection.activate(key);
  }
}
