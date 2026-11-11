// Sign-in for the Kode account relay: palm scans in Kode's own palm library
// and CloudBase email codes.
//
// The relay advertises its OIDC issuer and enabled sign-in methods from
// /api/v1/healthz, so the phone only needs the relay URL. Every method ends
// with CloudBase access/refresh tokens the relay verifies itself. Palm
// sign-up needs no other account: the relay mints the account id and the
// phone enrols a palm for it.
import 'dart:convert';

import 'package:dio/dio.dart';

import '../protocol/protocol.dart';
import 'api_client.dart';

/// Prefilled relay URL. Empty in source builds, so users enter the relay
/// they run or trust; release builds may inject one with
/// `--dart-define=KODE_RELAY_URL=https://…`.
const defaultRelayUrl = String.fromEnvironment('KODE_RELAY_URL');

/// Refresh this long before expiry so requests never carry a token the relay
/// is about to reject.
const accountRefreshMargin = Duration(minutes: 5);

/// How an account session was obtained. The relay's `login_methods` decides
/// which ones are offered; unknown ids are ignored.
enum LoginMethod {
  /// Kode's own 1:N palm scan, run in-app through the Palm H5 SDK.
  palm,
  email;

  static LoginMethod? parse(String? id) =>
      LoginMethod.values.where((m) => m.name == id).firstOrNull;
}

class AccountSession {
  final String serverUrl;
  final String issuer;

  /// Empty for accounts without an address (palm sign-ups).
  final String email;
  final LoginMethod method;

  /// Display name and HTTPS avatar from the CloudBase profile; empty when
  /// unset. Every sign-in method reaches the same account and profile.
  final String name;
  final String picture;
  final String userId;
  final String accessToken;
  final String refreshToken;

  /// Access-token expiry in epoch milliseconds.
  final int expiresAt;

  const AccountSession({
    required this.serverUrl,
    required this.issuer,
    required this.email,
    this.method = LoginMethod.email,
    this.name = '',
    this.picture = '',
    required this.userId,
    required this.accessToken,
    required this.refreshToken,
    required this.expiresAt,
  });

  /// What the UI calls this account: its name, else its address, else a
  /// short account id. Never the sign-in method.
  String get label {
    if (name.trim().isNotEmpty) return name.trim();
    if (email.isNotEmpty) return email;
    final tail = userId.length > 4
        ? userId.substring(userId.length - 4)
        : userId;
    return 'Kode · $tail';
  }

  bool needsRefresh(DateTime now) =>
      expiresAt <= now.add(accountRefreshMargin).millisecondsSinceEpoch;

  /// The endpoint the rest of the app uses to talk to one account desktop.
  Endpoint endpointFor(AccountDevice device) => Endpoint(
    serverUrl: serverUrl,
    token: accessToken,
    deviceId: device.deviceId,
    deviceName: device.name,
    serverKind: Endpoint.relayKind,
  );

  Map<String, dynamic> toJson() => {
    'server_url': serverUrl,
    'issuer': issuer,
    'email': email,
    'method': method.name,
    'name': name,
    'picture': picture,
    'user_id': userId,
    'access_token': accessToken,
    'refresh_token': refreshToken,
    'expires_at': expiresAt,
  };

  factory AccountSession.fromJson(Map<String, dynamic> j) => AccountSession(
    serverUrl: j['server_url'] as String,
    issuer: j['issuer'] as String,
    email: j['email'] as String? ?? '',
    method: LoginMethod.parse(j['method'] as String?) ?? LoginMethod.email,
    name: j['name'] as String? ?? '',
    picture: j['picture'] as String? ?? '',
    userId: j['user_id'] as String,
    accessToken: j['access_token'] as String,
    refreshToken: j['refresh_token'] as String,
    expiresAt: (j['expires_at'] as num).toInt(),
  );

  AccountSession copyWith({
    String? email,
    String? name,
    String? picture,
    String? accessToken,
    String? refreshToken,
    int? expiresAt,
  }) => AccountSession(
    serverUrl: serverUrl,
    issuer: issuer,
    email: email ?? this.email,
    method: method,
    name: name ?? this.name,
    picture: picture ?? this.picture,
    userId: userId,
    accessToken: accessToken ?? this.accessToken,
    refreshToken: refreshToken ?? this.refreshToken,
    expiresAt: expiresAt ?? this.expiresAt,
  );
}

class AccountDevice {
  final String deviceId;
  final String name;
  final bool online;

  const AccountDevice({
    required this.deviceId,
    required this.name,
    required this.online,
  });

  factory AccountDevice.fromJson(Map<String, dynamic> j) => AccountDevice(
    deviceId: j['device_id'] as String,
    name: j['name'] as String? ?? 'Kode Desktop',
    online: j['online'] as bool? ?? false,
  );
}

/// The relay's palm capture settings from `login_methods`.
class PalmConfig {
  final String serverUrl;
  final String appId;
  const PalmConfig({required this.serverUrl, required this.appId});

  /// The relay-hosted page that runs the Palm H5 SDK.
  Uri captureUri({
    String mode = 'recognition',
    String? token,
    String? userId,
    String lang = 'zh-CN',
  }) => Uri.parse('$serverUrl/palm/capture').replace(
    queryParameters: {
      'mode': mode,
      'app_id': appId,
      'lang': lang,
      'token': ?token,
      'user_id': ?userId,
    },
  );
}

/// What the capture page reports. Only `sessionId` matters to the relay;
/// the reported user id is never trusted.
class PalmCaptureResult {
  final int code;
  final String message;
  final String? sessionId;
  const PalmCaptureResult(this.code, this.message, [this.sessionId]);

  bool get ok => code == 0 && sessionId != null;

  factory PalmCaptureResult.fromJson(Map<String, dynamic> j) {
    final data = j['data'];
    return PalmCaptureResult(
      (j['code'] as num?)?.toInt() ?? 10000,
      j['message'] as String? ?? '',
      data is Map<String, dynamic> ? data['sessionId'] as String? : null,
    );
  }

  /// User-facing text for the SDK result codes Kode can act on.
  String get friendly => switch (code) {
    0 => 'Done.',
    10002 => 'Cancelled.',
    10003 => 'Camera access is off. Allow it in Settings to scan your palm.',
    10006 => 'Palm scanning is not supported on this device.',
    10008 =>
      'The scan timed out. Try again with your palm flat and in good light.',
    10101 => 'The image was not clear enough. Try again in better light.',
    10103 => 'This palm is already enrolled.',
    10104 => 'This palm is too similar to another account\'s.',
    10200 =>
      'No account matches this palm. Sign in another way and enrol it first.',
    10500 => 'Network error. Check your connection and try again.',
    _ => 'Palm scan failed ($code). $message',
  };
}

/// A palm-only sign-up in progress: an SDK token that can only enrol
/// [userId], which the relay minted.
class PalmRegistration {
  final String serverUrl;
  final String id;
  final String secret;
  final String userId;
  final String token;
  const PalmRegistration({
    required this.serverUrl,
    required this.id,
    required this.secret,
    required this.userId,
    required this.token,
  });
}

/// A desktop's `kode://palm-login?relay=…&id=…` QR.
class PalmHandoff {
  final String relay;
  final String id;
  const PalmHandoff(this.relay, this.id);

  static PalmHandoff? tryParse(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || uri.scheme != 'kode' || uri.host != 'palm-login') {
      return null;
    }
    final relay = uri.queryParameters['relay'];
    final id = uri.queryParameters['id'];
    if (relay == null || id == null || id.isEmpty || !trustedIssuer(relay)) {
      return null;
    }
    return PalmHandoff(AccountClient.normalizeServerUrl(relay), id);
  }
}

/// A code was emailed; the id must accompany the code the user types.
class PendingSignIn {
  final String serverUrl;
  final String issuer;
  final String email;
  final String verificationId;
  final bool isUser;
  final Duration expiresIn;

  const PendingSignIn({
    required this.serverUrl,
    required this.issuer,
    required this.email,
    required this.verificationId,
    required this.isUser,
    required this.expiresIn,
  });
}

class AccountClient {
  /// [deviceId] supplies this install's stable CloudBase device id. Every
  /// relay sign-in and CloudBase refresh carries it, so signing in here never
  /// evicts the account's sessions on other phones or desktops.
  AccountClient({Dio? dio, Future<String> Function()? deviceId})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              connectTimeout: const Duration(seconds: 8),
              receiveTimeout: const Duration(seconds: 15),
              headers: const {'Content-Type': 'application/json'},
              validateStatus: (_) => true,
            ),
          ) {
    if (deviceId != null) {
      _dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) async {
            options.headers['x-device-id'] = await deviceId();
            handler.next(options);
          },
        ),
      );
    }
  }

  final Dio _dio;

  static String normalizeServerUrl(String raw) =>
      raw.trim().replaceAll(RegExp(r'/+$'), '');

  Future<Map<String, dynamic>> _health(String serverUrl) async {
    final response = await _dio.get<dynamic>('$serverUrl/api/v1/healthz');
    final body = _map(response.data);
    if (body['server_kind'] != 'kode-relay') {
      throw ApiException(
        response.statusCode ?? 0,
        'not_a_relay',
        'This server is not a Kode account relay.',
      );
    }
    return body;
  }

  /// Sign-in methods the relay offers, in its order. Relays predating the
  /// list offer email only.
  Future<List<LoginMethod>> loginMethods(String serverUrl) async {
    final body = await _health(normalizeServerUrl(serverUrl));
    return parseLoginMethods(body);
  }

  static List<LoginMethod> parseLoginMethods(Map<String, dynamic> health) {
    final listed = health['login_methods'];
    if (listed is! List) return const [LoginMethod.email];
    return listed
        .whereType<Map<String, dynamic>>()
        .map((m) => LoginMethod.parse(m['id'] as String?))
        .whereType<LoginMethod>()
        .toList(growable: false);
  }

  Future<PalmConfig> palmConfig(String serverUrl) async {
    final server = normalizeServerUrl(serverUrl);
    final health = await _health(server);
    final palm = (health['login_methods'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .where((m) => m['id'] == 'palm')
        .firstOrNull;
    final appId = palm?['app_id'] as String?;
    if (appId == null) {
      throw ApiException(
        0,
        'no_palm',
        'This relay does not offer palm sign-in.',
      );
    }
    return PalmConfig(serverUrl: server, appId: appId);
  }

  /// Exchanges a capture session for CloudBase tokens.
  Future<AccountSession> palmSignIn(String serverUrl, String sessionId) async {
    final server = normalizeServerUrl(serverUrl);
    final issuer = await relayIssuer(server);
    final body = await _relay(
      'POST',
      '$server/api/v1/auth/palm',
      body: {'session_id': sessionId},
    );
    return _withProfile(_sessionFrom(body, server, issuer, LoginMethod.palm));
  }

  Future<PalmRegistration> palmRegisterStart(String serverUrl) async {
    final server = normalizeServerUrl(serverUrl);
    final body = await _relay('POST', '$server/api/v1/auth/palm/register');
    return PalmRegistration(
      serverUrl: server,
      id: body['registration_id'] as String,
      secret: body['secret'] as String,
      userId: body['user_id'] as String,
      token: body['token'] as String,
    );
  }

  /// Creates the account once Palm confirms the enrolment for it.
  Future<AccountSession> palmRegisterFinish(
    PalmRegistration registration,
    String sessionId,
  ) async {
    final issuer = await relayIssuer(registration.serverUrl);
    final body = await _relay(
      'POST',
      '${registration.serverUrl}/api/v1/auth/palm/register/finish',
      body: {
        'registration_id': registration.id,
        'secret': registration.secret,
        'session_id': sessionId,
      },
    );
    return _sessionFrom(body, registration.serverUrl, issuer, LoginMethod.palm);
  }

  /// Signs a waiting desktop in with this phone's palm scan.
  Future<void> approveHandoff(PalmHandoff handoff, String sessionId) => _relay(
    'POST',
    '${handoff.relay}/api/v1/auth/palm/handoff/${Uri.encodeComponent(handoff.id)}/approve',
    body: {'session_id': sessionId},
  );

  /// A short-lived SDK token that can only enrol this account's palm.
  Future<String> palmEnrollToken(AccountSession session) async {
    final body = await _relay(
      'POST',
      '${session.serverUrl}/api/v1/palm/enroll_token',
      token: session.accessToken,
    );
    return body['token'] as String;
  }

  Future<bool> palmEnrolled(AccountSession session) async {
    final body = await _relay(
      'GET',
      '${session.serverUrl}/api/v1/palm',
      token: session.accessToken,
    );
    return body['enrolled'] == true;
  }

  Future<void> forgetPalm(AccountSession session) => _relay(
    'DELETE',
    '${session.serverUrl}/api/v1/palm',
    token: session.accessToken,
  );

  Future<Map<String, dynamic>> _relay(
    String method,
    String url, {
    Map<String, dynamic>? body,
    String? token,
  }) async {
    final response = await _dio.request<dynamic>(
      url,
      data: body,
      options: Options(
        method: method,
        headers: {if (token != null) 'Authorization': 'Bearer $token'},
      ),
    );
    final data = _map(response.data);
    final status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) return data;
    throw ApiException(
      status,
      data['error'] as String? ?? 'http_$status',
      data['detail'] as String? ?? 'The account relay returned $status.',
    );
  }

  AccountSession _sessionFrom(
    Map<String, dynamic> body,
    String server,
    String issuer,
    LoginMethod method,
  ) {
    final access = body['access_token'] as String?;
    final refresh = body['refresh_token'] as String?;
    if (access == null || refresh == null) {
      throw ApiException(0, 'no_tokens', 'Sign-in returned no tokens.');
    }
    return AccountSession(
      serverUrl: server,
      issuer: issuer,
      email: '',
      method: method,
      userId: body['sub'] as String? ?? jwtSubject(access) ?? '',
      accessToken: access,
      refreshToken: refresh,
      expiresAt: _expiry(body),
    );
  }

  /// Copies the CloudBase profile (name, avatar, address) onto a session.
  /// Best effort: an unreachable profile keeps what the session had.
  Future<AccountSession> withProfile(AccountSession session) async {
    try {
      final response = await _dio.get<dynamic>(
        '${session.issuer}/auth/v1/user/me',
        options: Options(
          headers: {'Authorization': 'Bearer ${session.accessToken}'},
        ),
      );
      if ((response.statusCode ?? 0) == 200) {
        return applyProfile(session, _map(response.data));
      }
    } catch (_) {}
    return session;
  }

  Future<AccountSession> _withProfile(AccountSession session) =>
      withProfile(session);

  /// Sets the display name on the CloudBase profile.
  Future<AccountSession> setName(AccountSession session, String raw) async {
    final name = raw.trim();
    if (name.isEmpty || name.runes.length > 32) {
      throw ApiException(0, 'bad_name', 'Enter a name of 1–32 characters.');
    }
    final response = await _dio.patch<dynamic>(
      '${session.issuer}/auth/v1/user/profile',
      data: {'name': name},
      options: Options(
        headers: {'Authorization': 'Bearer ${session.accessToken}'},
      ),
    );
    final body = _map(response.data);
    final status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw ApiException(
        status,
        body['error'] as String? ?? 'profile',
        body['error_description'] as String? ?? 'Could not save the name.',
      );
    }
    return applyProfile(session.copyWith(name: name), body);
  }

  Future<String> relayIssuer(String serverUrl) async {
    final response = await _dio.get<dynamic>('$serverUrl/api/v1/healthz');
    final body = _map(response.data);
    if (body['server_kind'] != 'kode-relay') {
      throw ApiException(
        response.statusCode ?? 0,
        'not_a_relay',
        'This server is not a Kode account relay.',
      );
    }
    final issuer = (body['issuer'] as String?)?.replaceAll(RegExp(r'/+$'), '');
    if (issuer == null || !trustedIssuer(issuer)) {
      throw ApiException(
        response.statusCode ?? 0,
        'no_issuer',
        'The account relay has no sign-in provider configured.',
      );
    }
    return issuer;
  }

  Future<PendingSignIn> sendCode(String serverUrl, String email) async {
    final server = normalizeServerUrl(serverUrl);
    final issuer = await relayIssuer(server);
    final body = await _post(issuer, '/auth/v1/verification', {
      'email': email.trim(),
      'target': 'ANY',
    });
    final id = body['verification_id'] as String?;
    if (id == null) {
      throw ApiException(0, 'no_verification', 'No verification id returned.');
    }
    return PendingSignIn(
      serverUrl: server,
      issuer: issuer,
      email: email.trim(),
      verificationId: id,
      isUser: body['is_user'] as bool? ?? false,
      expiresIn: Duration(
        seconds: (body['expires_in'] as num?)?.toInt() ?? 600,
      ),
    );
  }

  Future<AccountSession> signIn(PendingSignIn pending, String code) async {
    final verified = await _post(
      pending.issuer,
      '/auth/v1/verification/verify',
      {
        'verification_id': pending.verificationId,
        'verification_code': code.trim(),
      },
    );
    final verificationToken = verified['verification_token'] as String?;
    if (verificationToken == null) {
      throw ApiException(0, 'invalid_code', 'The code was not accepted.');
    }
    // First-time addresses become accounts; known ones sign in.
    final body = await _post(
      pending.issuer,
      pending.isUser ? '/auth/v1/signin' : '/auth/v1/signup',
      {'email': pending.email, 'verification_token': verificationToken},
    );
    final access = body['access_token'] as String?;
    final refresh = body['refresh_token'] as String?;
    if (access == null || refresh == null) {
      throw ApiException(0, 'no_tokens', 'Sign-in returned no tokens.');
    }
    final userId = body['sub'] as String? ?? jwtSubject(access);
    if (userId == null) {
      throw ApiException(0, 'no_subject', 'Access token has no subject.');
    }
    return _withProfile(
      AccountSession(
        serverUrl: pending.serverUrl,
        issuer: pending.issuer,
        email: pending.email,
        userId: userId,
        accessToken: access,
        refreshToken: refresh,
        expiresAt: _expiry(body),
      ),
    );
  }

  /// Standard OIDC refresh grant; keeps the old refresh token unless the
  /// provider rotates it.
  Future<AccountSession> refresh(AccountSession session) async {
    final body = await _post(session.issuer, '/auth/v1/token', {
      'grant_type': 'refresh_token',
      'refresh_token': session.refreshToken,
    });
    final access = body['access_token'] as String?;
    if (access == null) {
      throw ApiException(401, 'expired', 'Account session expired.');
    }
    // Also picks up a name or avatar set on another device.
    return _withProfile(
      session.copyWith(
        accessToken: access,
        refreshToken: body['refresh_token'] as String?,
        expiresAt: _expiry(body),
      ),
    );
  }

  Future<List<AccountDevice>> devices(AccountSession session) async {
    final response = await _dio.get<dynamic>(
      '${session.serverUrl}/api/v1/account/devices',
      options: Options(
        headers: {'Authorization': 'Bearer ${session.accessToken}'},
      ),
    );
    final code = response.statusCode ?? 0;
    final body = _map(response.data);
    if (code < 200 || code >= 300) {
      throw ApiException(
        code,
        body['error'] as String? ?? 'http_$code',
        body['detail'] as String? ?? 'device list failed',
      );
    }
    return (body['devices'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(AccountDevice.fromJson)
        .toList(growable: false);
  }

  int _expiry(Map<String, dynamic> body) => DateTime.now()
      .add(Duration(seconds: (body['expires_in'] as num?)?.toInt() ?? 3600))
      .millisecondsSinceEpoch;

  Future<Map<String, dynamic>> _post(
    String issuer,
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _dio.post<dynamic>('$issuer$path', data: body);
    final code = response.statusCode ?? 0;
    final data = _map(response.data);
    if (code >= 200 && code < 300) return data;
    throw ApiException(
      code,
      data['error'] as String? ?? 'http_$code',
      data['error_description'] as String? ??
          data['message'] as String? ??
          'Sign-in provider returned $code.',
    );
  }

  static Map<String, dynamic> _map(dynamic data) {
    if (data is Map<String, dynamic>) return data;
    if (data is String && data.isNotEmpty) {
      try {
        final decoded = jsonDecode(data);
        if (decoded is Map<String, dynamic>) return decoded;
      } catch (_) {}
    }
    return const {};
  }
}

/// Sign-in codes and tokens travel to the issuer, so it must use TLS. Plain
/// HTTP is accepted only for loopback development servers.
bool trustedIssuer(String issuer) {
  final uri = Uri.tryParse(issuer);
  if (uri == null || uri.host.isEmpty) return false;
  if (uri.scheme == 'https') return true;
  return uri.scheme == 'http' &&
      (uri.host == '127.0.0.1' || uri.host == 'localhost');
}

/// Reads `sub` from a JWT payload without verifying it; only used on tokens
/// just returned by the provider. The relay performs the verification.
String? jwtSubject(String token) {
  final parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    final payload = utf8.decode(
      base64Url.decode(base64Url.normalize(parts[1])),
    );
    final json = jsonDecode(payload);
    return json is Map<String, dynamic> ? json['sub'] as String? : null;
  } catch (_) {
    return null;
  }
}

/// CloudBase ignores empty and null profile writes, so blank values mean
/// "unset". Avatars must be HTTPS; an address is never replaced.
AccountSession applyProfile(AccountSession session, Map<String, dynamic> p) {
  String? field(String key) {
    final value = p[key];
    return value is String && value.trim().isNotEmpty ? value.trim() : null;
  }

  final picture = field('picture');
  return session.copyWith(
    name: field('name'),
    picture: picture != null && picture.startsWith('https://') ? picture : null,
    email: session.email.isEmpty ? field('email') : null,
  );
}
