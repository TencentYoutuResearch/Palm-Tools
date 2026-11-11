import Foundation
import Security

/// One server binding pushed from the iPhone (`Endpoint.toJson()` in Dart).
struct ServerBinding: Codable, Hashable, Identifiable {
  let serverURL: String
  let token: String
  let deviceID: String
  let deviceName: String
  let workerID: String?
  let workerName: String?
  let serverKind: String?
  let storageKey: String

  enum CodingKeys: String, CodingKey {
    case serverURL = "server_url"
    case token
    case deviceID = "device_id"
    case deviceName = "device_name"
    case workerID = "worker_id"
    case workerName = "worker_name"
    case serverKind = "server_kind"
    case storageKey = "storage_key"
  }

  var id: String { storageKey }
  /// Account-relay desktops share one server; the desktop is a header.
  var isRelay: Bool { serverKind == "kode-relay" }
  var activeWorkerID: String { workerID ?? deviceID }
  var displayName: String { workerName ?? deviceName }
  var baseURL: String {
    var url = serverURL
    while url.hasSuffix("/") { url.removeLast() }
    return url
  }
}

struct BindingSet: Codable, Equatable {
  var bindings: [ServerBinding]
  var active: String?

  /// Parses the WatchConnectivity application context sent by the phone.
  init?(context: [String: Any]) {
    guard let raw = context["endpoints"] as? [[String: Any]],
      let data = try? JSONSerialization.data(withJSONObject: raw),
      let bindings = try? JSONDecoder().decode([ServerBinding].self, from: data)
    else { return nil }
    self.bindings = bindings
    self.active = context["active"] as? String
  }
}

/// Bearer tokens live in the watch keychain, never in UserDefaults.
enum BindingVault {
  private static let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "dev.kode.watch",
    kSecAttrAccount as String: "bindings",
  ]

  static func load() -> BindingSet? {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return try? JSONDecoder().decode(BindingSet.self, from: data)
  }

  static func save(_ set: BindingSet) {
    guard let data = try? JSONEncoder().encode(set) else { return }
    SecItemDelete(query as CFDictionary)
    var insert = query
    insert[kSecValueData as String] = data
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(insert as CFDictionary, nil)
  }
}
