/// Apple Watch companion credential sync.
///
/// The watch app talks to the same central server over REST, so it needs the
/// phone's bindings. They travel through WatchConnectivity's application
/// context (latest value wins, delivered when the watch next wakes). Account
/// relay tokens rotate; every rotation is pushed again, and the watch asks
/// for a refresh when the server rejects its copy.
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../protocol/protocol.dart';
import '../state/providers.dart';

const watchChannel = MethodChannel('kode/watch');

/// Payload pushed to the watch. Exposed for tests.
Map<String, Object?> watchContext(List<Endpoint> endpoints, Endpoint? active) {
  final all = [
    ...endpoints,
    if (active != null &&
        !endpoints.any((e) => e.storageKey == active.storageKey))
      active,
  ];
  return {
    'version': 1,
    'endpoints': [
      for (final endpoint in all)
        {...endpoint.toJson(), 'storage_key': endpoint.storageKey},
    ],
    // Application contexts accept property-list values only, never null.
    'active': ?active?.storageKey,
  };
}

final watchLinkProvider = Provider<void>((ref) {
  if (kIsWeb || !Platform.isIOS) return;

  var disposed = false;
  Future<void> push() async {
    if (disposed) return;
    final payload = watchContext(
      ref.read(savedEndpointsProvider),
      ref.read(endpointProvider),
    );
    try {
      await watchChannel.invokeMethod<void>('updateContext', payload);
    } on PlatformException catch (error) {
      debugPrint('[watch] context push failed: ${error.message}');
    } on MissingPluginException {
      // Hosts without the native channel (tests, other embedders).
    }
  }

  watchChannel.setMethodCallHandler((call) async {
    if (call.method != 'credentialsRequested') return null;
    // The watch saw a 401: rotate the account token if due, then resend.
    await ref.read(accountProvider.notifier).ensureFresh();
    await push();
    return null;
  });
  ref.onDispose(() {
    disposed = true;
    watchChannel.setMethodCallHandler(null);
  });

  ref.listen(endpointProvider, (_, _) => unawaited(push()));
  ref.listen(savedEndpointsProvider, (_, _) => unawaited(push()));
  unawaited(push());
});
