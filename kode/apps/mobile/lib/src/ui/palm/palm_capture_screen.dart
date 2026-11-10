// Runs the Palm H5 SDK in a WebView on the relay-hosted capture page
// (`/palm/capture`) and returns what the page reports. The page is fetched
// over HTTP and loaded with the relay URL as its base: navigating to a
// CloudBase test domain shows CloudBase's notice page instead. The page talks back
// through the `KodePalm` JavaScript channel, or by navigating to
// `kodepalm://result#<json>`, which is intercepted and never loaded.
//
// The SDK records a short video with MediaRecorder and runs SIMD wasm, so
// iOS needs 16.4+, and WKWebView must advertise "Safari" in its user agent or
// the SDK picks a recording format WebKit cannot produce.
import 'dart:convert';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../../api/account_client.dart';

/// Whether this device can run the H5 palm SDK at all.
Future<bool> palmCaptureSupported() async {
  if (Platform.isAndroid) return true;
  if (!Platform.isIOS) return false;
  final version = (await DeviceInfoPlugin().iosInfo).systemVersion;
  return iosSupportsPalm(version);
}

/// iOS 16.4 is the first WebKit with wasm SIMD and MediaRecorder.
bool iosSupportsPalm(String systemVersion) {
  final parts = systemVersion.split('.').map(int.tryParse).toList();
  final major = parts.firstOrNull ?? 0;
  final minor = parts.length > 1 ? parts[1] ?? 0 : 0;
  return major > 16 || (major == 16 && minor >= 4);
}

/// Parses what the capture page sends back, from either channel.
PalmCaptureResult? parseCaptureMessage(String message) {
  var raw = message;
  if (raw.startsWith('kodepalm://')) {
    final hash = raw.indexOf('#');
    if (hash < 0) return null;
    raw = Uri.decodeComponent(raw.substring(hash + 1));
  }
  try {
    final decoded = jsonDecode(raw);
    return decoded is Map<String, dynamic>
        ? PalmCaptureResult.fromJson(decoded)
        : null;
  } catch (_) {
    return null;
  }
}

/// Asks for consent once per call site, then runs the capture page.
/// Returns null when the user backs out before a result.
Future<PalmCaptureResult?> capturePalm(
  BuildContext context,
  Uri page, {
  required bool enrol,
}) async {
  final agreed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(enrol ? 'Enrol your palm' : 'Scan your palm'),
      content: Text(
        enrol
            ? 'Kode uses Tencent Palm to record your palm features and link '
                  'them to this Kode account, so you can sign in with your '
                  'palm. You can delete them at any time in the account menu.'
            : 'Kode uses Tencent Palm to match your palm against enrolled '
                  'palms. The camera image is processed by Tencent Palm and '
                  'not stored by Kode.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Continue'),
        ),
      ],
    ),
  );
  if (agreed != true || !context.mounted) return null;
  if (Platform.isAndroid && !await Permission.camera.request().isGranted) {
    return const PalmCaptureResult(10003, 'camera permission denied');
  }
  if (!context.mounted) return null;
  return Navigator.of(context).push<PalmCaptureResult>(
    MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => PalmCaptureScreen(page: page),
    ),
  );
}

class PalmCaptureScreen extends StatefulWidget {
  final Uri page;
  const PalmCaptureScreen({super.key, required this.page});

  @override
  State<PalmCaptureScreen> createState() => _PalmCaptureScreenState();
}

class _PalmCaptureScreenState extends State<PalmCaptureScreen> {
  late final WebViewController _controller;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    final params = WebViewPlatform.instance is WebKitWebViewPlatform
        ? WebKitWebViewControllerCreationParams(
            allowsInlineMediaPlayback: true,
            mediaTypesRequiringUserAction: const {},
          )
        : const PlatformWebViewControllerCreationParams();
    _controller =
        WebViewController.fromPlatformCreationParams(
            params,
            onPermissionRequest: (request) => request.grant(),
          )
          ..setJavaScriptMode(JavaScriptMode.unrestricted)
          ..setBackgroundColor(const Color(0xFF0D0F0E))
          ..addJavaScriptChannel(
            'KodePalm',
            onMessageReceived: (message) => _finish(message.message),
          )
          ..setNavigationDelegate(
            NavigationDelegate(
              onNavigationRequest: (request) {
                if (request.url.startsWith('kodepalm://')) {
                  _finish(request.url);
                  return NavigationDecision.prevent;
                }
                return NavigationDecision.navigate;
              },
            ),
          );
    _load();
  }

  Future<void> _load() async {
    final agent = await _controller.getUserAgent() ?? '';
    if (!agent.contains('Safari')) {
      await _controller.setUserAgent('$agent Safari/604.1');
    }
    try {
      final response = await Dio(
        BaseOptions(
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 15),
          responseType: ResponseType.plain,
        ),
      ).getUri<String>(widget.page);
      final html = response.data ?? '';
      if (!html.contains('PalmMobileManager')) {
        throw StateError('not the palm page');
      }
      await _controller.loadHtmlString(html, baseUrl: widget.page.toString());
    } catch (_) {
      if (!mounted || _done) return;
      _done = true;
      Navigator.of(
        context,
      ).pop(const PalmCaptureResult(10500, 'cannot load the palm page'));
    }
  }

  void _finish(String message) {
    if (_done || !mounted) return;
    final result = parseCaptureMessage(message);
    if (result == null) return;
    _done = true;
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0D0F0E),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        foregroundColor: Colors.white,
        leading: IconButton(
          icon: const Icon(Icons.close),
          tooltip: 'Cancel',
          onPressed: () =>
              Navigator.of(context).pop(const PalmCaptureResult(10002, '')),
        ),
      ),
      extendBodyBehindAppBar: true,
      body: WebViewWidget(controller: _controller),
    );
  }
}
