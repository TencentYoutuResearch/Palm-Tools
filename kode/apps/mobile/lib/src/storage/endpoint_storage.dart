// 端点 + token 持久化(钥匙串 / Android Keystore)。
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../protocol/protocol.dart';

const _legacyKey = 'kode_cloud_endpoint_v2';
const _key = 'kode_cloud_endpoints_v3';

class EndpointCollection {
  final List<Endpoint> endpoints;
  final String? activeKey;

  const EndpointCollection({this.endpoints = const [], this.activeKey});

  Endpoint? get active {
    if (endpoints.isEmpty) return null;
    return endpoints
        .where((endpoint) => endpoint.storageKey == activeKey)
        .firstOrNull;
  }

  EndpointCollection upsert(Endpoint endpoint) {
    final next =
        endpoints
            .where((saved) => saved.storageKey != endpoint.storageKey)
            .toList(growable: true)
          ..add(endpoint);
    return EndpointCollection(endpoints: next, activeKey: endpoint.storageKey);
  }

  EndpointCollection activate(String key) {
    if (!endpoints.any((endpoint) => endpoint.storageKey == key)) return this;
    return EndpointCollection(endpoints: endpoints, activeKey: key);
  }

  EndpointCollection remove(String key) {
    final next = endpoints
        .where((endpoint) => endpoint.storageKey != key)
        .toList(growable: false);
    return EndpointCollection(
      endpoints: next,
      activeKey: activeKey == key ? next.firstOrNull?.storageKey : activeKey,
    );
  }

  Map<String, dynamic> toJson() => {
    'active_key': activeKey,
    'endpoints': endpoints.map((endpoint) => endpoint.toJson()).toList(),
  };

  factory EndpointCollection.fromJson(Map<String, dynamic> json) {
    final endpoints = (json['endpoints'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(Endpoint.fromJson)
        .toList(growable: false);
    return EndpointCollection(
      endpoints: endpoints,
      activeKey: json['active_key'] as String?,
    );
  }
}

class EndpointStorage {
  static const _store = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<Endpoint?> load() async {
    return (await loadCollection()).active;
  }

  Future<EndpointCollection> loadCollection() async {
    final raw = await _store.read(key: _key);
    if (raw != null && raw.isNotEmpty) {
      try {
        return EndpointCollection.fromJson(
          jsonDecode(raw) as Map<String, dynamic>,
        );
      } catch (_) {}
    }
    final legacy = await _store.read(key: _legacyKey);
    if (legacy == null || legacy.isEmpty) return const EndpointCollection();
    try {
      final endpoint = Endpoint.fromJson(
        jsonDecode(legacy) as Map<String, dynamic>,
      );
      final migrated = EndpointCollection().upsert(endpoint);
      await _write(migrated);
      return migrated;
    } catch (_) {
      return const EndpointCollection();
    }
  }

  Future<void> save(Endpoint e) async {
    await _write((await loadCollection()).upsert(e));
  }

  Future<void> activate(String key) async {
    await _write((await loadCollection()).activate(key));
  }

  Future<EndpointCollection> remove(String key) async {
    final next = (await loadCollection()).remove(key);
    await _write(next);
    return next;
  }

  Future<void> clear() async {
    await _store.delete(key: _key);
    await _store.delete(key: _legacyKey);
  }

  Future<void> _write(EndpointCollection collection) async {
    await _store.write(key: _key, value: jsonEncode(collection.toJson()));
    await _store.delete(key: _legacyKey);
  }
}
