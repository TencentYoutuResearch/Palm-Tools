import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/ui/sessions/backend_identity.dart';

void main() {
  test('maps backend aliases to the same visual identity', () {
    expect(backendIdentity('claude-internal').asset, 'claudecode');
    expect(backendIdentity('/opt/bin/cursor-agent').asset, 'cursor');
    expect(backendIdentity('codex').label, 'Codex');
  });

  test('unknown backends receive a readable monogram fallback', () {
    final identity = backendIdentity('my_custom-agent');

    expect(identity.asset, isNull);
    expect(identity.fallback, 'MC');
    expect(identity.label, 'my_custom-agent');
  });

  testWidgets('canonical backend artwork is bundled for mobile', (_) async {
    final path = backendIdentity('codex').assetPath!;

    final bytes = await rootBundle.load(path);

    expect(bytes.lengthInBytes, greaterThan(0));
  });

  testWidgets('status avatar only shows a dot while working', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: BackendStatusAvatar(backendKey: 'codex', working: true),
        ),
      ),
    );

    expect(find.byKey(const ValueKey('working-status-dot')), findsOneWidget);
    expect(find.bySemanticsLabel('Codex agent, working'), findsOneWidget);

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: BackendStatusAvatar(backendKey: 'codex', working: false),
        ),
      ),
    );

    expect(find.byKey(const ValueKey('working-status-dot')), findsNothing);
    expect(find.bySemanticsLabel('Codex agent'), findsOneWidget);
    semantics.dispose();
  });
}
