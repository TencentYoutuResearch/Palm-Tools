import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/glass.dart';
import 'package:kode_mobile/src/ui/theme.dart';
import 'package:kode_mobile/src/ui/devices/devices_screen.dart';
import 'package:kode_mobile/src/ui/sessions/sessions_screen.dart';
import 'package:kode_mobile/src/ui/sessions/session_detail_screen.dart';

final office = Endpoint(
  serverUrl: 'https://sync.example.com',
  token: 'test',
  deviceId: 'office',
  deviceName: 'Office Mac',
);

class PreviewApi extends ApiClient {
  PreviewApi() : super(office);
  @override
  Future<List<SessionDto>> listSessions() async => [
    SessionDto(
      id: 1,
      backendKey: 'codex',
      title: 'Polish the mobile experience',
      model: 'gpt-test',
      status: 'busy',
      cwd: '/workspace/kode',
      tokens: TokensDto(total: 18400),
      contextPct: 24,
    ),
    SessionDto(
      id: 2,
      backendKey: 'claude',
      title: 'Review device synchronization',
      model: 'claude-test',
      status: 'idle',
      cwd: '/workspace/kode',
      tokens: TokensDto(total: 6200),
      contextPct: 12,
    ),
  ];
  @override
  Future<List<Envelope>> getHistory(
    int id, {
    int? fromMs,
    int? limit,
  }) async => [
    Envelope(
      protocolVersion: 'v1',
      schemaVersion: 1,
      sessionId: 1,
      ts: 1,
      type: 'message',
      payload: {
        'id': 'one',
        'role': 'user',
        'text': 'Make the mobile app feel lighter and more native.',
      },
    ),
    Envelope(
      protocolVersion: 'v1',
      schemaVersion: 1,
      sessionId: 1,
      ts: 2,
      type: 'message',
      payload: {
        'id': 'two',
        'role': 'assistant',
        'text':
            'The navigation and composer now use a soft glass material.\n\nYour conversations stay readable in both light and dark mode.',
      },
    ),
  ];
}

void main() {
  const output = String.fromEnvironment('GLASS_SCREENSHOT_DIR');
  const fontPath = String.fromEnvironment('GLASS_FONT_PATH');
  const iconFontPath = String.fromEnvironment('GLASS_ICON_FONT_PATH');
  setUpAll(() async {
    if (fontPath.isNotEmpty) {
      final bytes = ByteData.sublistView(await File(fontPath).readAsBytes());
      for (final name in [
        '.SF Pro Text',
        '.SF Pro Display',
        'Roboto',
        'Menlo',
        'Ahem',
      ]) {
        await (FontLoader(name)..addFont(Future.value(bytes))).load();
      }
    }
    if (iconFontPath.isNotEmpty) {
      final bytes = ByteData.sublistView(
        await File(iconFontPath).readAsBytes(),
      );
      await (FontLoader('MaterialIcons')..addFont(Future.value(bytes))).load();
    }
  });

  testWidgets('high contrast and reduced motion remove backdrop filtering', (
    tester,
  ) async {
    for (final data in [
      const MediaQueryData(highContrast: true),
      const MediaQueryData(disableAnimations: true),
    ]) {
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: data,
            child: const GlassSurface(
              blur: true,
              child: Text('Readable content'),
            ),
          ),
        ),
      );
      // Keep the widget mounted to preserve focused form fields; the filter
      // itself must be disabled for accessibility settings.
      expect(
        tester
            .widgetList<BackdropFilter>(find.byType(BackdropFilter))
            .every((filter) => !filter.enabled),
        isTrue,
      );
      expect(find.text('Readable content'), findsOneWidget);
    }
  });

  for (final dark in [false, true]) {
    for (final page in ['sessions', 'devices', 'conversation']) {
      testWidgets('$page glass layout ${dark ? 'dark' : 'light'}', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              endpointProvider.overrideWith((ref) => office),
              savedEndpointsProvider.overrideWith(
                (ref) => [
                  office,
                  Endpoint(
                    serverUrl: office.serverUrl,
                    token: 'test-home',
                    deviceId: 'home',
                    deviceName: 'Home MacBook',
                  ),
                ],
              ),
              apiClientProvider.overrideWithValue(PreviewApi()),
              eventStreamProvider.overrideWith((ref) => const Stream.empty()),
            ],
            child: MaterialApp(
              theme: dark ? KillLaTheme.dark() : KillLaTheme.light(),
              home: RepaintBoundary(
                key: const ValueKey('preview'),
                child: page == 'sessions'
                    ? const SessionsScreen()
                    : page == 'devices'
                    ? const DevicesScreen()
                    : const SessionDetailScreen(sessionId: 1),
              ),
            ),
          ),
        );
        // A busy session intentionally keeps its progress indicator animating.
        // Wait for history/chrome measurement, not for all animations to stop.
        for (var frame = 0; frame < 12; frame++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(tester.takeException(), isNull);
        expect(find.byType(GlassScaffold), findsOneWidget);
        if (page == 'conversation') {
          expect(
            find.byKey(const ValueKey('session-floating-composer')),
            findsOneWidget,
          );
          expect(
            find.byKey(const ValueKey('session-transcript')),
            findsOneWidget,
          );
        }
        if (page == 'conversation') {
          expect(find.text('gpt-test'), findsNothing);
          await tester.tap(
            find.byKey(const ValueKey('session-composer-input')),
          );
          await tester.pump(const Duration(milliseconds: 300));
          final model = find.byKey(const ValueKey('session-composer-model'));
          final permission = find.byKey(
            const ValueKey('session-permission-menu'),
          );
          expect(model, findsOneWidget);
          expect(
            tester.getTopLeft(model).dx,
            greaterThan(tester.getTopLeft(permission).dx),
          );
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('session-floating-composer')),
              matching: find.text('gpt-test'),
            ),
            findsOneWidget,
          );
          await tester.enterText(
            find.byKey(const ValueKey('session-composer-input')),
            'Keep this draft',
          );
          await tester.pump(const Duration(milliseconds: 300));
          expect(tester.takeException(), isNull);
        }
        if (output.isNotEmpty) {
          await expectLater(
            find.byKey(const ValueKey('preview')),
            matchesGoldenFile(
              Uri.file('$output/$page-${dark ? 'dark' : 'light'}.png'),
            ),
          );
        }
      });
    }
  }
}
