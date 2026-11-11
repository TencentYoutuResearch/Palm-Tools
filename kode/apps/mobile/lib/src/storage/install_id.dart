// Per-install device id sent to CloudBase as `x-device-id`.
//
// Generated once and reused for every sign-in and refresh, so this phone
// always holds the same CloudBase session slot. It lives in the app's own
// support directory, not the Keychain: iOS keeps Keychain items after the
// app is deleted, while a reinstall must count as a new device.
import 'dart:io';
import 'dart:math';

import 'package:path_provider/path_provider.dart';

class InstallId {
  InstallId._();

  static Future<String>? _cached;

  static Future<String> load() => _cached ??= _loadOrCreate();

  static Future<String> _loadOrCreate() async {
    final dir = await getApplicationSupportDirectory();
    final file = File('${dir.path}/install_id');
    if (await file.exists()) {
      final saved = (await file.readAsString()).trim();
      if (isValid(saved)) return saved;
    }
    final id = newUuid();
    await dir.create(recursive: true);
    await file.writeAsString(id, flush: true);
    return id;
  }

  /// Same shape the relay accepts (`client_device_id`).
  static bool isValid(String id) =>
      id.length >= 8 &&
      id.length <= 64 &&
      RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(id);

  /// RFC 4122 version 4 UUID.
  static String newUuid([Random? random]) {
    final rng = random ?? Random.secure();
    final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
