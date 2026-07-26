import 'package:flutter_secure_storage/flutter_secure_storage.dart';

// v2 adds an explicit first network access before bootstrap so iOS can show
// its Wireless Data prompt at a predictable moment.
const _localNetworkGateKey = 'kode_local_network_gate_v2';

class LocalNetworkGateStorage {
  static const _store = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<bool> load() async {
    final raw = await _store.read(key: _localNetworkGateKey);
    return raw == '1';
  }

  Future<void> saveAccepted() async {
    await _store.write(key: _localNetworkGateKey, value: '1');
  }
}
