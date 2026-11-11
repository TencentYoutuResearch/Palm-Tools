import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/platform/watch_link.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';

void main() {
  Endpoint endpoint(String device, {String? kind}) => Endpoint(
    serverUrl: 'https://relay.example/',
    token: 'token-$device',
    deviceId: device,
    deviceName: 'Desk $device',
    serverKind: kind,
  );

  test('watch context carries every binding and the active key', () {
    final a = endpoint('a', kind: Endpoint.relayKind);
    final b = endpoint('b');
    final context = watchContext([a, b], b);

    expect(context['active'], b.storageKey);
    final endpoints = context['endpoints']! as List;
    expect(endpoints, hasLength(2));
    final first = endpoints.first as Map;
    expect(first['storage_key'], a.storageKey);
    expect(first['token'], 'token-a');
    expect(first['server_kind'], Endpoint.relayKind);
  });

  test('an unsaved active endpoint is still sent to the watch', () {
    final active = endpoint('c');
    final context = watchContext(const [], active);
    expect(context['endpoints'], hasLength(1));
    expect(context['active'], active.storageKey);
  });

  test('signing out clears the watch copy', () {
    final context = watchContext(const [], null);
    expect(context['endpoints'], isEmpty);
    expect(context.containsKey('active'), isFalse);
  });
}
