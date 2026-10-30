import 'dart:async';
import 'dart:io';
import 'package:flutter/services.dart';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/protocol/session_setup.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/sessions/new_session_screen.dart';
import 'package:kode_mobile/src/ui/sessions/project_path_tile.dart';
import 'package:kode_mobile/src/ui/sessions/sessions_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

class FakeSetupApi extends ApiClient {
  FakeSetupApi()
    : super(
        Endpoint(
          serverUrl: 'https://sync.example.com',
          token: 'test',
          deviceId: 'desktop',
          deviceName: 'Test desktop',
        ),
      );
  final calls = <Map<String, String?>>[];
  final directories = <String?>[];
  final modelReplies = <String, Completer<ModelCatalogue>>{};
  Completer<SessionDto>? creation;
  bool catalogueFails = false;
  bool empty = false;
  bool directoryFails = false;
  List<SessionDto> sessions = [];

  @override
  Future<List<SessionDto>> listSessions() async => sessions;
  @override
  Future<BackendCatalogue> listBackends() async {
    if (catalogueFails) {
      throw ApiException(409, 'offline', 'Desktop is offline');
    }
    return BackendCatalogue(
      empty
          ? []
          : [
              const BackendOption(
                key: 'codex',
                label: 'Codex',
                modelFlag: '--model',
                bypassLabel: 'Full access',
              ),
              const BackendOption(
                key: 'claude',
                label: 'Claude',
                modelFlag: '--model',
              ),
            ],
      '/workspace',
    );
  }

  @override
  Future<ModelCatalogue> listModels(String key) =>
      modelReplies[key]?.future ??
      Future.value(
        ModelCatalogue([ModelOption(id: '$key-model', label: '$key model')]),
      );
  @override
  Future<DirectoryListing> listDirectories({
    String? path,
    bool showHidden = false,
  }) async {
    directories.add(path);
    if (directoryFails) {
      throw ApiException(404, 'not_found', 'Directory does not exist');
    }
    return DirectoryListing(
      path: path ?? '/workspace',
      parent: '/',
      entries: [const DirectoryOption('project', '/workspace/project')],
    );
  }

  @override
  Future<SessionDto> createSession({
    required String backendKey,
    String? cwd,
    String? model,
    String? resumeSessionUuid,
    String? permissionMode,
    String? requestId,
  }) {
    calls.add({
      'backend': backendKey,
      'cwd': cwd,
      'model': model,
      'permission': permissionMode,
      'request': requestId,
    });
    return creation?.future ??
        Future.value(
          SessionDto(
            id: 42,
            backendKey: backendKey,
            title: 'Created',
            model: model ?? 'auto',
            status: 'idle',
            cwd: cwd,
            tokens: TokensDto(),
          ),
        );
  }
}

Future<void> showSetup(
  WidgetTester tester,
  FakeSetupApi api, {
  bool dark = false,
}) async {
  final router = GoRouter(
    initialLocation: '/sessions',
    routes: [
      GoRoute(path: '/sessions', builder: (_, _) => const SessionsScreen()),
      GoRoute(
        path: '/sessions/new',
        builder: (_, _) => const NewSessionScreen(),
      ),
      GoRoute(
        path: '/sessions/:id',
        builder: (_, state) =>
            Scaffold(body: Text('Session ${state.pathParameters['id']}')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        endpointProvider.overrideWith((ref) => api.endpoint),
        apiClientProvider.overrideWithValue(api),
        eventStreamProvider.overrideWith((ref) => const Stream.empty()),
      ],
      child: RepaintBoundary(
        key: const ValueKey('new-session-preview'),
        child: MaterialApp.router(
          theme: dark ? KillLaTheme.dark() : KillLaTheme.light(),
          routerConfig: router,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('New session'));
  await tester.pumpAndSettle();
}

void main() {
  const output = String.fromEnvironment('GLASS_SCREENSHOT_DIR');
  setUpAll(() async {
    const font = String.fromEnvironment('GLASS_FONT_PATH');
    const icons = String.fromEnvironment('GLASS_ICON_FONT_PATH');
    for (final entry in {
      '.SF Pro Text': font,
      '.SF Pro Display': font,
      'Roboto': font,
      'Ahem': font,
      'MaterialIcons': icons,
    }.entries) {
      if (entry.value.isNotEmpty) {
        final bytes = ByteData.sublistView(
          await File(entry.value).readAsBytes(),
        );
        await (FontLoader(entry.key)..addFont(Future.value(bytes))).load();
      }
    }
  });
  testWidgets('existing project selection and failed child navigation retry', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeSetupApi()
      ..sessions = [
        SessionDto(
          id: 1,
          backendKey: 'codex',
          title: 'Existing session',
          model: 'auto',
          status: 'idle',
          cwd: '/workspace/clients/mobile/application',
          tokens: TokensDto(),
        ),
      ];
    await showSetup(tester, api);
    await tester.ensureVisible(find.byType(ProjectPathTile));
    await tester.tap(find.byType(ProjectPathTile));
    await tester.pumpAndSettle();
    expect(
      tester.widget<ProjectPathTile>(find.byType(ProjectPathTile)).selected,
      isTrue,
    );
    expect(
      tester.widget<TextFormField>(find.byType(TextFormField)).controller!.text,
      '/workspace/clients/mobile/application',
    );
    if (output.isNotEmpty) {
      await expectLater(
        find.byKey(const ValueKey('new-session-preview')),
        matchesGoldenFile(Uri.file('$output/project-selection.png')),
      );
    }
    await tester.ensureVisible(find.byTooltip('Browse desktop directories'));
    await tester.tap(find.byTooltip('Browse desktop directories'));
    await tester.pumpAndSettle();
    if (output.isNotEmpty) {
      await expectLater(
        find.byKey(const ValueKey('new-session-preview')),
        matchesGoldenFile(Uri.file('$output/directory-picker.png')),
      );
    }
    api.directoryFails = true;
    await tester.tap(find.text('project'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    api.directoryFails = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(api.directories.last, '/workspace/project');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'selects desktop model and directory then opens created session',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = FakeSetupApi();
      await showSetup(tester, api);
      await tester.tap(find.byType(DropdownButtonFormField<String>).at(1));
      await tester.pumpAndSettle();
      await tester.tap(find.text('codex model').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Browse desktop directories'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('project'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use this directory'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Create session'));
      await tester.tap(find.text('Create session'));
      await tester.pumpAndSettle();
      expect(api.calls.single, containsPair('model', 'codex-model'));
      expect(api.calls.single, containsPair('cwd', '/workspace/project'));
      expect(find.text('Session 42'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('bypass launch option is sent only for backends that support it', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeSetupApi();
    await showSetup(tester, api);
    expect(find.text('Full access'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const ValueKey('new-session-bypass')));
    await tester.tap(find.byKey(const ValueKey('new-session-bypass')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Create session'));
    await tester.tap(find.text('Create session'));
    await tester.pumpAndSettle();
    expect(api.calls.single, containsPair('permission', 'bypass'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('backends without a bypass mode hide the launch option', (
    tester,
  ) async {
    final api = FakeSetupApi();
    await showSetup(tester, api);
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('new-session-bypass')), findsNothing);
  });

  testWidgets(
    'unknown creation outcome reuses request and prevents edits or double submit',
    (tester) async {
      final api = FakeSetupApi()..creation = Completer<SessionDto>();
      await showSetup(tester, api, dark: true);
      await tester.tap(find.text('Create session'));
      await tester.pump();
      await tester.tap(find.text('Create session'));
      expect(api.calls, hasLength(1));
      api.creation!.completeError(
        ApiException(504, 'creation_unconfirmed', 'Unknown'),
      );
      await tester.pumpAndSettle();
      expect(find.text('Check creation result'), findsOneWidget);
      expect(
        tester.widget<TextFormField>(find.byType(TextFormField)).enabled,
        isFalse,
      );
      api.creation = null;
      await tester.tap(find.text('Check creation result'));
      await tester.pumpAndSettle();
      expect(api.calls, hasLength(2));
      expect(api.calls[0], api.calls[1]);
      expect(find.text('Session 42'), findsOneWidget);
    },
  );

  testWidgets('late model response cannot overwrite another backend', (
    tester,
  ) async {
    final api = FakeSetupApi();
    api.modelReplies['codex'] = Completer<ModelCatalogue>();
    // A continuously animating loading indicator cannot pumpAndSettle.
    api.modelReplies['codex']!.complete(const ModelCatalogue([]));
    await showSetup(tester, api);
    api.modelReplies['claude'] = Completer<ModelCatalogue>();
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').last);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Codex').last);
    await tester.pumpAndSettle();
    api.modelReplies['claude']!.complete(
      const ModelCatalogue([ModelOption(id: 'stale', label: 'Stale model')]),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButtonFormField<String>).at(1));
    await tester.pumpAndSettle();
    expect(find.text('Stale model'), findsNothing);
    expect(find.text('Backend default'), findsWidgets);
  });

  testWidgets('offline and empty catalogue can be refreshed', (tester) async {
    final api = FakeSetupApi()..catalogueFails = true;
    await showSetup(tester, api);
    expect(find.text('Desktop is offline'), findsOneWidget);
    api.catalogueFails = false;
    api.empty = true;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.textContaining('No available backends'), findsOneWidget);
    api.empty = false;
    await tester.tap(find.text('Refresh'));
    await tester.pumpAndSettle();
    expect(find.text('Create session'), findsOneWidget);
  });

  testWidgets('invalid paths are not submitted; directory errors recover', (
    tester,
  ) async {
    final api = FakeSetupApi();
    await showSetup(tester, api);
    await tester.enterText(find.byType(TextFormField), 'relative/path');
    await tester.tap(find.text('Create session'));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);
    expect(
      find.text('Choose or enter an absolute desktop path.'),
      findsOneWidget,
    );
    api.directoryFails = true;
    await tester.tap(find.byTooltip('Browse desktop directories'));
    await tester.pumpAndSettle();
    expect(find.text('Directory does not exist'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    api.directoryFails = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('Directory does not exist'), findsNothing);
  });
}
