import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/account_client.dart';
import 'package:kode_mobile/src/storage/install_id.dart';

import 'account_relay_test.dart' show FakeRelay;

void main() {
  test('install ids are v4 UUIDs the relay accepts', () {
    final id = InstallId.newUuid(Random(1));
    expect(
      id,
      matches(
        RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        ),
      ),
    );
    expect(InstallId.isValid(id), isTrue);
    expect(InstallId.isValid('bad id!'), isFalse);
    expect(InstallId.newUuid(), isNot(InstallId.newUuid()));
  });

  test('sign-in and refresh carry the same device id', () async {
    final server = await FakeRelay.start();
    addTearDown(server.close);
    final client = AccountClient(deviceId: () async => 'install-0001-phone');

    final session = await client.palmSignIn(server.url, 'ses_1');
    await client.refresh(session);

    final seen = {
      for (final request in server.requests)
        request.uri.path: request.headers.value('x-device-id'),
    };
    expect(seen['/api/v1/auth/palm'], 'install-0001-phone');
    expect(seen['/auth/v1/token'], 'install-0001-phone');
  });
}
