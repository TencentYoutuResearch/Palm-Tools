import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';

/// Per-origin gateway cookies used by platform ingress layers such as
/// DevCloud AIO-Forward.
///
/// These cookies are deliberately kept in memory. They are gateway session
/// credentials, not Kode binding credentials, and can be re-established with
/// a harmless `/healthz` handshake after an app restart.
class GatewaySession {
  GatewaySession._(this.origin);

  static final Map<String, GatewaySession> _sessions = {};

  factory GatewaySession.forServer(String serverUrl) {
    final parsed = Uri.parse(serverUrl);
    final origin = parsed.replace(path: '', query: null, fragment: null);
    return _sessions.putIfAbsent(
      origin.toString(),
      () => GatewaySession._(origin),
    );
  }

  final Uri origin;
  final Map<String, Cookie> _cookies = {};
  Future<void>? _ready;

  Dio createDio(BaseOptions options) {
    final dio = Dio(options);
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (request, handler) async {
          try {
            await ensureReady();
            _applyCookies(request.headers);
            handler.next(request);
          } catch (error, stackTrace) {
            handler.reject(
              DioException(
                requestOptions: request,
                type: DioExceptionType.connectionError,
                error: error,
                stackTrace: stackTrace,
              ),
            );
          }
        },
        onResponse: (response, handler) {
          _absorb(response.headers);
          handler.next(response);
        },
      ),
    );
    return dio;
  }

  Future<void> ensureReady({bool refresh = false}) async {
    if (refresh) _ready = null;
    final current = _ready ??= _warmUp();
    try {
      await current;
    } catch (_) {
      if (identical(_ready, current)) _ready = null;
      rethrow;
    }
  }

  Future<void> _warmUp() async {
    final dio = Dio(
      BaseOptions(
        baseUrl: origin.toString(),
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 15),
        validateStatus: (_) => true,
        responseType: ResponseType.plain,
      ),
    );

    // Some gateways set their access cookie on the first response and only
    // accept the second request. Never follow this with a state-changing call
    // until the cookie challenge has had one retry.
    for (var attempt = 0; attempt < 2; attempt++) {
      final headers = <String, dynamic>{};
      _applyCookies(headers);
      final before = _cookieHeader;
      final response = await dio.get<String>(
        '/healthz',
        options: Options(headers: headers, responseType: ResponseType.plain),
      );
      _absorb(response.headers);
      if (response.statusCode != HttpStatus.forbidden ||
          _cookieHeader == before) {
        return;
      }
    }
  }

  bool isAioForbidden(Response<dynamic> response) {
    if (response.statusCode != HttpStatus.forbidden) return false;
    return (response.headers.value('x-proxy-by') ?? '').toLowerCase().contains(
      'aio-forward',
    );
  }

  Future<Map<String, String>> websocketHeaders(String bearerToken) async {
    await ensureReady();
    final headers = <String, String>{
      HttpHeaders.authorizationHeader: 'Bearer $bearerToken',
    };
    final cookie = _cookieHeader;
    if (cookie.isNotEmpty) headers[HttpHeaders.cookieHeader] = cookie;
    return headers;
  }

  void _absorb(Headers headers) {
    for (final raw
        in headers[HttpHeaders.setCookieHeader] ?? const <String>[]) {
      try {
        final cookie = Cookie.fromSetCookieValue(raw);
        if (cookie.maxAge != null && cookie.maxAge! <= 0) {
          _cookies.remove(cookie.name);
        } else {
          _cookies[cookie.name] = cookie;
        }
      } catch (_) {
        // Ignore malformed gateway cookies without breaking the Kode API.
      }
    }
  }

  void _applyCookies(Map<String, dynamic> headers) {
    final cookie = _cookieHeader;
    if (cookie.isNotEmpty) headers[HttpHeaders.cookieHeader] = cookie;
  }

  String get _cookieHeader {
    final now = DateTime.now();
    _cookies.removeWhere((_, cookie) {
      final expired = cookie.expires?.isBefore(now) ?? false;
      final wrongScheme = cookie.secure && origin.scheme != 'https';
      return expired || wrongScheme;
    });
    return _cookies.values
        .map((cookie) => '${cookie.name}=${cookie.value}')
        .join('; ');
  }
}
