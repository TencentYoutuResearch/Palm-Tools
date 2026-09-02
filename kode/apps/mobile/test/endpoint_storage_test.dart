import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/storage/endpoint_storage.dart';

Endpoint _endpoint(String id, String name, {String token = 'token'}) =>
    Endpoint(
      serverUrl: 'https://sync.example.com',
      token: '$token-$id',
      deviceId: id,
      deviceName: name,
    );

void main() {
  test('endpoint collection keeps independent device credentials', () {
    final first = _endpoint('desktop-1', 'Office Mac');
    final second = _endpoint('desktop-2', 'Home Mac');

    final collection = const EndpointCollection().upsert(first).upsert(second);

    expect(collection.endpoints, hasLength(2));
    expect(collection.active?.deviceId, 'desktop-2');
    expect(collection.endpoints.map((endpoint) => endpoint.token), {
      'token-desktop-1',
      'token-desktop-2',
    });
  });

  test('upsert refreshes one binding without duplicating it', () {
    final endpoint = _endpoint('desktop-1', 'Office Mac');
    final collection = const EndpointCollection()
        .upsert(endpoint)
        .upsert(_endpoint('desktop-1', 'Office Mac renamed', token: 'new'));

    expect(collection.endpoints, hasLength(1));
    expect(collection.active?.deviceName, 'Office Mac renamed');
    expect(collection.active?.token, 'new-desktop-1');
  });

  test('removing the active device selects the next saved device', () {
    final first = _endpoint('desktop-1', 'Office Mac');
    final second = _endpoint('desktop-2', 'Home Mac');
    final collection = const EndpointCollection()
        .upsert(first)
        .upsert(second)
        .remove(second.storageKey);

    expect(collection.endpoints, [first]);
    expect(collection.active, first);
  });

  test('collection JSON preserves active device selection', () {
    final first = _endpoint('desktop-1', 'Office Mac');
    final second = _endpoint('desktop-2', 'Home Mac');
    final original = const EndpointCollection()
        .upsert(first)
        .upsert(second)
        .activate(first.storageKey);

    final restored = EndpointCollection.fromJson(original.toJson());

    expect(restored.endpoints, hasLength(2));
    expect(restored.active?.deviceId, 'desktop-1');
  });
}
