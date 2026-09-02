import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/devices/devices_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

Endpoint _endpoint(String id, String name, String serverUrl) => Endpoint(
  serverUrl: serverUrl,
  token: 'token-$id',
  deviceId: id,
  deviceName: name,
);

void main() {
  testWidgets('device ledger identifies the active desktop in text', (
    tester,
  ) async {
    final office = _endpoint(
      'office',
      'Office Mac',
      'https://office.example.com',
    );
    final home = _endpoint('home', 'Home Mac', 'https://home.example.com');

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          endpointProvider.overrideWith((ref) => office),
          savedEndpointsProvider.overrideWith((ref) => [office, home]),
        ],
        child: MaterialApp(
          theme: KillLaTheme.light(),
          home: const DevicesScreen(),
        ),
      ),
    );

    expect(find.text('Office Mac'), findsOneWidget);
    expect(find.text('Home Mac'), findsOneWidget);
    expect(find.text('office.example.com · Current'), findsOneWidget);
    expect(find.text('Add device with QR code'), findsOneWidget);
    expect(find.byIcon(Icons.computer_rounded), findsNWidgets(2));
  });
}
