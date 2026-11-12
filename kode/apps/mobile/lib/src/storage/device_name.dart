// What this phone is called in the account's signed-in device list.
//
// iOS 16+ reports the generic "iPhone" as the device name without a special
// entitlement, so the model name ("iPhone 15 Pro") stands in for it.
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';

class DeviceName {
  DeviceName._();

  static Future<String>? _cached;

  static Future<String> load() => _cached ??= _read();

  static Future<String> _read() async {
    try {
      final info = DeviceInfoPlugin();
      if (Platform.isIOS) {
        final ios = await info.iosInfo;
        final name = ios.name.trim();
        return name.isEmpty || name == ios.model ? ios.modelName : name;
      }
      if (Platform.isAndroid) {
        final android = await info.androidInfo;
        return '${android.manufacturer} ${android.model}'.trim();
      }
      return Platform.localHostname;
    } catch (_) {
      return 'Kode Mobile';
    }
  }
}
