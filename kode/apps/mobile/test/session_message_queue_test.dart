import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/sessions/session_detail_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

class _FakeApiClient extends ApiClient {
  final sent = <String>[];
  List<Envelope> history = const [];
  Future<InputDispatchReceipt> Function()? onSend;

  _FakeApiClient()
    : super(
        Endpoint(
          serverUrl: 'http://127.0.0.1:47870',
          token: 'test-token',
          deviceId: 'test-device',
          deviceName: 'Test desktop',
        ),
      );

  @override
  Future<List<SessionDto>> listSessions() async => const [];

  @override
  Future<List<Envelope>> getHistory(int id, {int? fromMs, int? limit}) async =>
      history;

  @override
  Future<InputDispatchReceipt> sendInputText(int id, String text) async {
    sent.add(text);
    return onSend?.call() ??
        const InputDispatchReceipt(commandId: 'cmd-test', status: 'dispatched');
  }
}

Envelope _commandEvent(String status, {String commandId = 'cmd-test'}) =>
    Envelope(
      protocolVersion: 'v1',
      schemaVersion: 1,
      sessionId: 7,
      ts: DateTime.now().millisecondsSinceEpoch,
      type: 'command.status',
      payload: {'command_id': commandId, 'status': status, 'error': null},
    );

Envelope _userMessageEvent(String text) => Envelope(
  protocolVersion: 'v1',
  schemaVersion: 1,
  sessionId: 7,
  ts: DateTime.now().millisecondsSinceEpoch,
  type: 'message',
  payload: {
    // Cloud envelopes rewrite session_id but preserve the desktop-local id
    // embedded in the semantic message payload. Text reconciliation must
    // therefore work even when the numeric id prefix differs.
    'id': '91-${sessionSemanticMessageId(7, text).split('-').last}',
    'role': 'user',
    'text': text,
  },
);

Envelope _assistantMessageEvent(int index) => Envelope(
  protocolVersion: 'v1',
  schemaVersion: 1,
  sessionId: 7,
  ts: index,
  type: 'message',
  payload: {
    'id': 'assistant-$index',
    'role': 'assistant',
    'text': [
      'History message $index',
      ...List.filled(
        index % 7 + 1,
        'Variable-height history content forces lazy list layout.',
      ),
    ].join('\n\n'),
  },
);

Future<void> _settle() async {
  await Future<void>.delayed(const Duration(milliseconds: 20));
}

Future<void> _pumpFrames(WidgetTester tester, [int count = 24]) async {
  for (var i = 0; i < count; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

void main() {
  test('semantic message id matches bridge UTF-8 FNV-1a', () {
    expect(sessionSemanticMessageId(7, 'hello'), '7-1335831723');
    expect(sessionSemanticMessageId(7, '发送消息'), '7-4277896786');
  });

  test('composer input is submitted immediately and shown as queued', () async {
    final api = _FakeApiClient();
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    container
        .read(sessionMessageQueueProvider.notifier)
        .enqueue(sessionId: 7, text: 'hello\r\nworld');
    await _settle();

    expect(api.sent, ['hello\nworld\n']);
    expect(
      container.read(sessionMessageQueueProvider)[7]!.single.status,
      SessionMessageQueueStatus.queued,
    );
  });

  test('executed command receipt changes queued message to sent', () async {
    final api = _FakeApiClient();
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    container
        .read(sessionMessageQueueProvider.notifier)
        .enqueue(sessionId: 7, text: 'send while busy');
    await _settle();
    events.add(_commandEvent('executed'));
    await _settle();

    expect(
      container.read(sessionMessageQueueProvider)[7]!.single.status,
      SessionMessageQueueStatus.sent,
    );
  });

  test('synced CLI user message changes sent message to processed', () async {
    final api = _FakeApiClient();
    final events = StreamController<Envelope>();
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await events.close();
    });

    container
        .read(sessionMessageQueueProvider.notifier)
        .enqueue(sessionId: 7, text: 'process this next');
    await _settle();
    events.add(_commandEvent('executed'));
    await _settle();
    events.add(_userMessageEvent('process this next'));
    await _settle();

    expect(
      container.read(sessionMessageQueueProvider)[7]!.single.status,
      SessionMessageQueueStatus.processed,
    );
  });

  test(
    'reconciles command confirmation that outruns the HTTP response',
    () async {
      final api = _FakeApiClient();
      final receipt = Completer<InputDispatchReceipt>();
      api.onSend = () => receipt.future;
      final events = StreamController<Envelope>();
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          eventStreamProvider.overrideWith((ref) => events.stream),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await events.close();
      });

      container
          .read(sessionMessageQueueProvider.notifier)
          .enqueue(sessionId: 7, text: 'fast confirmation');
      await _settle();
      events.add(_commandEvent('executed', commandId: 'cmd-fast'));
      await _settle();
      receipt.complete(
        const InputDispatchReceipt(commandId: 'cmd-fast', status: 'dispatched'),
      );
      await _settle();

      expect(
        container.read(sessionMessageQueueProvider)[7]!.single.status,
        SessionMessageQueueStatus.sent,
      );
    },
  );

  testWidgets('optimistic bubble stays visible and becomes processed', (
    tester,
  ) async {
    final api = _FakeApiClient();
    final receipt = Completer<InputDispatchReceipt>();
    api.onSend = () => receipt.future;
    final events = StreamController<Envelope>();
    addTearDown(events.close);
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: KillLaTheme.light(),
          home: const SessionDetailScreen(sessionId: 7),
        ),
      ),
    );
    await tester.pump();

    await tester.enterText(find.byType(TextField), 'keep this visible');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.arrow_upward_rounded));
    await tester.pump();
    expect(find.text('keep this visible'), findsOneWidget);
    expect(
      container.read(sessionMessageQueueProvider)[7]!.single.status,
      SessionMessageQueueStatus.submitting,
    );
    expect(find.text('SENT'), findsOneWidget);

    receipt.complete(
      const InputDispatchReceipt(
        commandId: 'cmd-visible',
        status: 'dispatched',
      ),
    );
    await tester.pump();
    expect(find.text('SENT'), findsOneWidget);

    events.add(_userMessageEvent('keep this visible'));
    await tester.pump();
    expect(find.text('keep this visible'), findsOneWidget);
    expect(find.text('PROCESSED'), findsOneWidget);
  });

  testWidgets('tapping outside the composer dismisses the software keyboard', (
    tester,
  ) async {
    final api = _FakeApiClient();
    final events = StreamController<Envelope>();
    addTearDown(events.close);
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: KillLaTheme.light(),
          home: const SessionDetailScreen(sessionId: 7),
        ),
      ),
    );
    await tester.pump();

    final composer = find.byType(TextField).first;
    await tester.tap(composer);
    await tester.enterText(composer, 'draft');
    expect(tester.testTextInput.isVisible, isTrue);

    // Tap the transcript area, which is outside the composer regardless of
    // whether the session already rendered an empty-state message.
    await tester.tapAt(const Offset(20, 120));
    await tester.pump();

    expect(tester.testTextInput.isVisible, isFalse);
    expect(
      tester
          .widget<EditableText>(find.byType(EditableText).first)
          .focusNode
          .hasFocus,
      isFalse,
    );
  });

  testWidgets('keyboard inset lifts the transcript and composer above it', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);

    final api = _FakeApiClient()
      ..history = List.generate(12, _assistantMessageEvent);
    final events = StreamController<Envelope>();
    addTearDown(events.close);
    final container = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => events.stream),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: KillLaTheme.light(),
          home: const SessionDetailScreen(sessionId: 7),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final composer = find.byType(TextField).first;
    await tester.tap(composer);
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pumpAndSettle();

    expect(tester.getBottomLeft(composer).dy, lessThanOrEqualTo(544));
    expect(
      tester.getBottomLeft(find.byKey(const ValueKey('session-transcript'))).dy,
      lessThanOrEqualTo(544),
    );
  });

  testWidgets(
    'opens at latest message and offers a jump back after scrolling',
    (tester) async {
      final api = _FakeApiClient()
        ..history = List.generate(160, _assistantMessageEvent);
      final events = StreamController<Envelope>();
      addTearDown(events.close);
      final container = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          eventStreamProvider.overrideWith((ref) => events.stream),
        ],
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            theme: KillLaTheme.light(),
            home: const SessionDetailScreen(sessionId: 7),
          ),
        ),
      );
      await tester.pump();
      await _pumpFrames(tester);

      expect(find.textContaining('History message 159'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('scroll-to-bottom')).hitTestable(),
        findsNothing,
      );

      await tester.drag(find.byType(ListView), const Offset(0, 420));
      await _pumpFrames(tester, 8);

      expect(find.byKey(const ValueKey('scroll-to-bottom')), findsOneWidget);

      tester
          .widget<IconButton>(find.byKey(const ValueKey('scroll-to-bottom')))
          .onPressed!();
      await _pumpFrames(tester, 40);

      final transcript = tester.widget<ListView>(
        find.byKey(const ValueKey('session-transcript')),
      );
      expect(transcript.controller!.position.extentAfter, lessThan(1));
      expect(
        find.byKey(const ValueKey('scroll-to-bottom')).hitTestable(),
        findsNothing,
      );
    },
  );
}
