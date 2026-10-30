import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/ui/pair/pair_screen.dart';

void main() {
  testWidgets(
    'pasting the dsh pairing link fills the manual fields without submitting',
    (tester) async {
      await tester.pumpWidget(
        const ProviderScope(child: MaterialApp(home: PairScreen())),
      );
      final fields = find.byType(TextField);
      await tester.ensureVisible(fields.first);
      await tester.enterText(
        fields.first,
        'kode://cloud-pair?server=https%3A%2F%2Fsync.example.com&pairing_id=pair_test&secret=kp_test',
      );
      await tester.pump();
      final inputs = tester.widgetList<TextField>(fields).toList();
      expect(inputs[0].controller!.text, 'https://sync.example.com');
      expect(inputs[1].controller!.text, 'pair_test');
      expect(inputs[2].controller!.text, 'kp_test');
      expect(inputs[2].obscureText, isTrue);
      expect(find.text('Pairing…'), findsNothing);
      expect(find.text('Pair device'), findsOneWidget);
    },
  );

  testWidgets(
    'typing a server URL preserves the separately entered pairing code',
    (tester) async {
      await tester.pumpWidget(
        const ProviderScope(child: MaterialApp(home: PairScreen())),
      );
      final fields = find.byType(TextField);
      await tester.ensureVisible(fields.at(1));
      await tester.enterText(fields.at(1), 'pair_manual');
      await tester.ensureVisible(fields.first);
      await tester.enterText(fields.first, 'https://sync.example.com');
      await tester.pump();
      final inputs = tester.widgetList<TextField>(fields).toList();
      expect(inputs[1].controller!.text, 'pair_manual');
      expect(inputs[2].controller!.text, isEmpty);
    },
  );
}
