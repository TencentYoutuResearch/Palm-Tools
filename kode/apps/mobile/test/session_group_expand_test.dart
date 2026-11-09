import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/sessions/sessions_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

final _endpoint = Endpoint(
  serverUrl: 'https://sync.example.com',
  token: 'test',
  deviceId: 'office',
  deviceName: 'Office Mac',
);

SessionDto _session(int id, String title, String cwd) => SessionDto(
  id: id,
  backendKey: 'codex',
  title: title,
  model: '',
  status: 'idle',
  cwd: cwd,
  tokens: TokensDto(),
);

class _Api extends ApiClient {
  _Api() : super(_endpoint);

  @override
  Future<List<SessionDto>> listSessions() async => [
    _session(1, 'Alpha session', '/work/app'),
    _session(2, 'Beta session', '/work/lib'),
  ];
}

Widget _harness(_Api api) => ProviderScope(
  overrides: [
    endpointProvider.overrideWith((ref) => _endpoint),
    apiClientProvider.overrideWithValue(api),
    wsClientProvider.overrideWith((ref) => null),
    eventStreamProvider.overrideWith((ref) => const Stream.empty()),
  ],
  child: MaterialApp(
    theme: KillLaTheme.dark(),
    home: const SessionsScreen(),
  ),
);

void main() {
  testWidgets('collapsing the last expanded folder keeps it collapsed', (
    tester,
  ) async {
    await tester.pumpWidget(_harness(_Api()));
    await tester.pumpAndSettle();

    // Both folders start expanded on first load.
    expect(find.text('Alpha session'), findsOneWidget);
    expect(find.text('Beta session'), findsOneWidget);

    final headers = find.byIcon(Icons.folder_copy_outlined);
    expect(headers, findsNWidgets(2));

    // Collapse the first folder, then the last one.
    await tester.tap(headers.at(0));
    await tester.pumpAndSettle();
    expect(find.text('Alpha session'), findsNothing);
    expect(find.text('Beta session'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.folder_copy_outlined).at(1));
    await tester.pumpAndSettle();

    // An empty expanded set must not be treated as "not initialized" on the
    // next rebuild (previously it re-expanded every group).
    expect(find.text('Alpha session'), findsNothing);
    expect(find.text('Beta session'), findsNothing);
  });
}
