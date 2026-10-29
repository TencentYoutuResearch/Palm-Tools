import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/protocol/session_setup.dart';
import 'package:kode_mobile/src/ui/sessions/session_model_sheet.dart';

void main() {
  testWidgets(
    'loads models and returns the selection without submitting a message',
    (tester) async {
      final result = Completer<ModelCatalogue>();
      String? selected;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  selected = await showModalBottomSheet<String>(
                    context: context,
                    builder: (_) => SessionModelSheet(
                      currentModel: 'a',
                      load: () => result.future,
                    ),
                  );
                },
                child: const Text('Choose'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Choose'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      result.complete(
        const ModelCatalogue([
          ModelOption(id: 'a', label: 'Alpha'),
          ModelOption(id: 'b', label: 'Beta'),
        ]),
      );
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.check), findsOneWidget);
      await tester.tap(find.text('Beta'));
      await tester.pumpAndSettle();
      expect(selected, 'b');
    },
  );

  testWidgets(
    'lookup failures can be retried and empty catalogues are explicit',
    (tester) async {
      var calls = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SessionModelSheet(
              currentModel: 'a',
              load: () async {
                if (++calls == 1) throw StateError('offline');
                return const ModelCatalogue([]);
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Retry'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(
        find.text('No models available from this backend.'),
        findsOneWidget,
      );
    },
  );
}
