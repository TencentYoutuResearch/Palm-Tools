import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/api/api_client.dart';
import 'package:kode_mobile/src/protocol/protocol.dart';
import 'package:kode_mobile/src/state/providers.dart';
import 'package:kode_mobile/src/ui/sessions/session_appearance.dart';
import 'package:kode_mobile/src/ui/sessions/sessions_screen.dart';
import 'package:kode_mobile/src/ui/theme.dart';

final _endpoint = Endpoint(
  serverUrl: 'https://relay.example.com',
  token: 'test',
  deviceId: 'mac-mini',
  deviceName: 'Mac Mini',
);

class _BotApi extends ApiClient {
  _BotApi(this._rows) : super(_endpoint);
  final List<SessionDto> _rows;

  @override
  Future<List<SessionDto>> listSessions() async => _rows;
}

void main() {
  test('SessionDto parses bot identity and synced artwork refs', () {
    final dto = SessionDto.fromJson({
      'id': 42,
      'backend_key': 'claude',
      'title': 'Fox Main',
      'model': 'claude-sonnet',
      'status': 'idle',
      'cwd': '/Users/me/.kode/plugins/bots/fox',
      'tokens': {'total': 0},
      'bot_id': 'fox',
      'bot_name': '小狐狸',
      'bot_tagline': '随行研发伙伴',
      'bot_kind': 'main',
      'avatar_id': 'gallery/fox',
      'banner': 'preset:blurple',
      'avatar_image': {
        'id': '0123456789abcdef0123456789abcdef',
        'mime': 'image/png',
        'size': 1234,
      },
      'background_image': {
        'id': 'fedcba9876543210fedcba9876543210',
        'mime': 'image/webp',
        'size': 5678,
      },
    });

    expect(dto.isBot, isTrue);
    expect(dto.botId, 'fox');
    expect(dto.botName, '小狐狸');
    expect(dto.botTagline, '随行研发伙伴');
    expect(dto.botKind, 'main');
    expect(dto.avatarId, 'gallery/fox');
    expect(dto.banner, 'preset:blurple');
    expect(dto.avatarImage?.id, '0123456789abcdef0123456789abcdef');
    expect(dto.backgroundImage?.mime, 'image/webp');
    expect(dto.copyWith(status: 'busy').botName, '小狐狸');
  });

  test('resolveBannerGradient handles presets, hex colors, and none', () {
    for (final id in [
      'blurple',
      'aurora',
      'cyber',
      'sunset',
      'forest',
      'sakura',
      'ocean',
      'amber',
    ]) {
      expect(resolveBannerGradient('preset:$id'), isNotNull, reason: id);
    }
    expect(resolveBannerGradient('color:#4f46e5'), isNotNull);
    expect(resolveBannerGradient('none'), isNull);
    expect(resolveBannerGradient('auto'), isNull);
    expect(resolveBannerGradient(null), isNull);
  });

  testWidgets('SessionsScreen separates bot section from workspace groups without duplicating adopted/subtask rows', (
    tester,
  ) async {
    final api = _BotApi([
      SessionDto(
        id: 1,
        backendKey: 'claude',
        title: 'Fox Adopted Task',
        model: 'claude-sonnet',
        status: 'idle',
        cwd: '/work/palm-tools',
        tokens: TokensDto(),
        botId: 'fox',
        botName: '小狐狸',
        botTagline: '随行研发伙伴',
        botKind: 'adopted',
        banner: 'preset:aurora',
      ),
      SessionDto(
        id: 3,
        backendKey: 'claude',
        title: 'Fox Subtask',
        model: 'claude-sonnet',
        status: 'busy',
        cwd: '/Users/me/.kode/plugins/bots/fox/sub',
        tokens: TokensDto(),
        botId: 'fox',
        botName: '小狐狸',
        botTagline: '随行研发伙伴',
        botKind: 'subtask',
      ),
      SessionDto(
        id: 2,
        backendKey: 'codex',
        title: 'Refactor auth',
        model: 'gpt-5',
        status: 'busy',
        cwd: '/work/palm-tools',
        tokens: TokensDto(),
      ),
    ]);

    await tester.pumpWidget(
      ProviderScope(
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
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('伙伴'), findsOneWidget);
    expect(find.text('工作区'), findsOneWidget);
    expect(find.text('小狐狸'), findsOneWidget);
    expect(find.text('随行研发伙伴'), findsOneWidget);
    expect(find.text('Refactor auth'), findsOneWidget);
    expect(find.text('palm-tools'), findsOneWidget);
    // Adopted/subtask bot sessions must NOT be duplicated in workspace groups
    expect(find.text('Fox Adopted Task'), findsNothing);
    // Tapping the multi-session count pill opens the bot's session sheet
    await tester.tap(find.text('2'));
    await tester.pumpAndSettle();
    expect(find.text('Fox Adopted Task'), findsOneWidget);
    expect(find.text('Fox Subtask'), findsOneWidget);
  });
}
