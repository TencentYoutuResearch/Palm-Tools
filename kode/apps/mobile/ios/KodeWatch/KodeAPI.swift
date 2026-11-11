import Foundation
import Security

struct APIError: LocalizedError {
  let status: Int
  let code: String
  let detail: String

  var errorDescription: String? { detail.isEmpty ? code : detail }
  var isAuth: Bool { status == 401 }
}

struct SessionSummary: Identifiable {
  let id: Int
  let backendKey: String
  let title: String
  let status: String
  let cwd: String?

  var displayTitle: String {
    if !title.isEmpty { return title }
    if let cwd, let last = cwd.split(separator: "/").last { return String(last) }
    return backendKey
  }
}

struct KodeEvent {
  let type: String
  let ts: Int
  let payload: [String: Any]
}

/// REST client for the phone API (`.specops/specs/remote-protocol.md`),
/// mirroring `lib/src/api/api_client.dart`. Every call on an account relay
/// also extends the desktop's viewing lease, so polling keeps it streaming.
actor KodeAPI {
  let binding: ServerBinding
  private let urlSession: URLSession
  private var warmedUp = false

  init(binding: ServerBinding) {
    self.binding = binding
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 15
    // Gateway cookies (e.g. AIO-Forward) ride the shared cookie storage.
    config.httpCookieStorage = .shared
    urlSession = URLSession(configuration: config)
  }

  func sessions() async throws -> [SessionSummary] {
    let body = try await send("GET", "/api/v1/sessions") as? [String: Any]
    let list = body?["sessions"] as? [[String: Any]] ?? []
    return list.compactMap { json in
      guard let id = (json["id"] as? NSNumber)?.intValue else { return nil }
      let status = json["status"] as? String ?? "starting"
      guard status != "exited" else { return nil }
      return SessionSummary(
        id: id,
        backendKey: json["backend_key"] as? String ?? "?",
        title: json["title"] as? String ?? "",
        status: status,
        cwd: json["cwd"] as? String
      )
    }
  }

  /// `from = 0` returns the newest window of the semantic timeline.
  func history(_ id: Int, limit: Int) async throws -> [KodeEvent] {
    let body =
      try await send(
        "GET", "/api/v1/sessions/\(id)/history",
        query: [URLQueryItem(name: "from", value: "0"), URLQueryItem(name: "limit", value: "\(limit)")]
      ) as? [String: Any]
    let list = body?["events"] as? [[String: Any]] ?? []
    return list.compactMap { json in
      guard let type = json["type"] as? String else { return nil }
      var payload = json["payload"] as? [String: Any] ?? [:]
      if let text = json["payload"] as? String, let data = text.data(using: .utf8),
        let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        payload = decoded
      }
      return KodeEvent(type: type, ts: (json["ts"] as? NSNumber)?.intValue ?? 0, payload: payload)
    }
  }

  func answer(_ id: Int, questionID: String, choice: Int, submit: Bool) async throws {
    var body: [String: Any] = ["question_id": questionID, "choice_index": choice]
    if submit { body["submit"] = true }
    let response = try await send("POST", "/api/v1/sessions/\(id)/answer", json: body, idempotent: true)
    try await awaitReceipt(id, response)
  }

  func structuredResponse(_ id: Int, requestID: String, response: [String: Any]) async throws {
    let reply = try await send(
      "POST", "/api/v1/sessions/\(id)/answer",
      json: ["request_id": requestID, "response": response], idempotent: true)
    try await awaitReceipt(id, reply)
  }

  func planResponse(_ id: Int, planID: String, accept: Bool) async throws {
    let response = try await send(
      "POST", "/api/v1/sessions/\(id)/plan_response",
      json: ["plan_id": planID, "accept": accept], idempotent: true)
    try await awaitReceipt(id, response)
  }

  func sendText(_ id: Int, text: String) async throws {
    let response = try await send(
      "POST", "/api/v1/sessions/\(id)/input", json: ["text": text], idempotent: true)
    try await awaitReceipt(id, response)
  }

  /// Cloud servers acknowledge with a command id; the desktop's
  /// `command.status` receipt in history is the real outcome.
  private func awaitReceipt(_ id: Int, _ response: Any?) async throws {
    guard let body = response as? [String: Any], let commandID = body["command_id"] as? String,
      body["status"] as? String != "executed"
    else { return }
    let deadline = Date().addingTimeInterval(35)
    while Date() < deadline {
      let events = try await history(id, limit: 2000)
      if let receipt = events.last(where: {
        $0.type == "command.status" && $0.payload["command_id"] as? String == commandID
      }) {
        switch receipt.payload["status"] as? String {
        case "executed": return
        case "failed", "expired":
          throw APIError(
            status: 409, code: "action_failed",
            detail: receipt.payload["error"] as? String ?? "Action was not executed.")
        default: break
        }
      }
      try await Task.sleep(nanoseconds: 600_000_000)
    }
    throw APIError(
      status: 408, code: "action_unconfirmed",
      detail: "No receipt from the desktop. Refresh before retrying.")
  }

  private func send(
    _ method: String,
    _ path: String,
    query: [URLQueryItem]? = nil,
    json: [String: Any]? = nil,
    idempotent: Bool = false
  ) async throws -> Any? {
    guard var components = URLComponents(string: binding.baseURL + path) else {
      throw APIError(status: 0, code: "bad_url", detail: binding.baseURL)
    }
    components.queryItems = query
    guard let url = components.url else {
      throw APIError(status: 0, code: "bad_url", detail: binding.baseURL)
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("Bearer \(binding.token)", forHTTPHeaderField: "Authorization")
    request.setValue(binding.activeWorkerID, forHTTPHeaderField: "X-Kode-Worker-Id")
    if binding.isRelay { request.setValue(binding.deviceID, forHTTPHeaderField: "X-Kode-Device") }
    if let json {
      request.httpBody = try JSONSerialization.data(withJSONObject: json)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if idempotent { request.setValue(Self.idempotencyKey(), forHTTPHeaderField: "Idempotency-Key") }

    await warmUp()
    var (data, response) = try await urlSession.data(for: request)
    if isAioForbidden(response) {
      // The gateway rejected the request before Kode saw it; renew its
      // cookie and replay once (same idempotency key).
      warmedUp = false
      await warmUp()
      (data, response) = try await urlSession.data(for: request)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let body = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)
    guard (200..<300).contains(status) else {
      let map = body as? [String: Any]
      throw APIError(
        status: status,
        code: map?["error"] as? String ?? "http_\(status)",
        detail: map?["detail"] as? String ?? "")
    }
    return body
  }

  /// Some ingress gateways set a cookie on the first response and only accept
  /// the second request, so a harmless `/healthz` goes first.
  private func warmUp() async {
    guard !warmedUp, let url = URL(string: binding.baseURL), let origin = url.originURL else {
      return
    }
    for _ in 0..<2 {
      guard
        let (_, response) = try? await urlSession.data(from: origin.appendingPathComponent("healthz")),
        isAioForbidden(response)
      else { break }
    }
    warmedUp = true
  }

  private func isAioForbidden(_ response: URLResponse) -> Bool {
    guard let http = response as? HTTPURLResponse, http.statusCode == 403 else { return false }
    let proxy = http.value(forHTTPHeaderField: "x-proxy-by") ?? ""
    return proxy.lowercased().contains("aio-forward")
  }

  private static func idempotencyKey() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    let entropy = Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return "\(Int(Date().timeIntervalSince1970 * 1_000_000))-\(entropy)"
  }
}

extension URL {
  fileprivate var originURL: URL? {
    guard var components = URLComponents(url: self, resolvingAgainstBaseURL: false) else {
      return nil
    }
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url
  }
}
