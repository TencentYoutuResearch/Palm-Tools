import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/ui/sessions/session_send_button.dart';

void main() {
  testWidgets('draft overrides running indicator and clearing restores it', (
    tester,
  ) async {
    var sent = 0;
    var stopped = 0;
    Future<void> show(bool working, String text) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SessionSendButton(
            working: working,
            text: text,
            onSend: () => sent++,
            onStop: () => stopped++,
          ),
        ),
      ),
    );
    await show(true, '');
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    await tester.tap(find.byType(FilledButton));
    expect(stopped, 1);
    final size = tester.getSize(find.byType(FilledButton));
    expect(size, const Size(40, 40));
    await show(true, '继续处理');
    expect(find.byType(CircularProgressIndicator), findsNothing);
    await tester.tap(find.byType(FilledButton));
    expect(sent, 1);
    expect(tester.getSize(find.byType(FilledButton)), size);
    await show(true, '  \n');
    expect(find.byIcon(Icons.stop_rounded), findsOneWidget);
    await show(false, '');
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    await show(false, 'new message');
    await tester.tap(find.byType(FilledButton));
    expect(sent, 2);
  });
}
