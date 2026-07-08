/// 端点 + token 持久化(钥匙串 / Android Keystore)。
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../protocol/protocol.dart';

const _key = 'kode_endpoint_v1';

class EndpointStorage {
  static const _store = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<Endpoint?> load() async {
    final raw = await _store.read(key: _key);
    if (raw == null || raw.isEmpty) return null;
    try {
      return Endpoint.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save(Endpoint e) async {
    await _store.write(key: _key, value: jsonEncode(e.toJson()));
  }

  Future<void> clear() async {
    await _store.delete(key: _key);
  }
}
