// Account sign-in persistence (Keychain / Android Keystore). Kept apart from
// QR endpoint bindings: one account session serves every account desktop.
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/account_client.dart';

const _key = 'kode_account_v1';

class AccountStorage {
  static const _store = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<AccountSession?> load() async {
    final raw = await _store.read(key: _key);
    if (raw == null || raw.isEmpty) return null;
    try {
      return AccountSession.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> save(AccountSession session) =>
      _store.write(key: _key, value: jsonEncode(session.toJson()));

  Future<void> clear() => _store.delete(key: _key);
}
