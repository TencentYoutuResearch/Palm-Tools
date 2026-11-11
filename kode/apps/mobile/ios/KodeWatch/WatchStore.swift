import Foundation
import WatchKit

struct SessionRow: Identifiable {
  let summary: SessionSummary
  let pending: PendingInteraction?
  let transcript: [TranscriptLine]
  var id: Int { summary.id }
}

enum WatchPhase: Equatable {
  case unpaired
  case loading
  case ready
  case needsPhone(String)
  case failed(String)
}

/// Polls the active desktop while the watch app is on screen. There is no
/// socket: each REST call already extends an account relay's viewing lease,
/// and polling stops as soon as the app leaves the foreground.
@MainActor
final class WatchStore: ObservableObject {
  @Published private(set) var bindings: BindingSet?
  @Published private(set) var rows: [SessionRow] = []
  @Published private(set) var phase: WatchPhase = .unpaired
  @Published var selectedKey: String? {
    didSet {
      UserDefaults.standard.set(selectedKey, forKey: Self.selectedKeyDefault)
      rebuildAPI()
    }
  }

  private static let selectedKeyDefault = "selected_binding"
  private static let pollInterval: UInt64 = 4_000_000_000
  private let link = PhoneLink()
  private var api: KodeAPI?
  private var pollTask: Task<Void, Never>?
  private var notifiedPending = Set<String>()
  private var lastCredentialRequest = Date.distantPast

  init() {
    bindings = BindingVault.load()
    selectedKey = UserDefaults.standard.string(forKey: Self.selectedKeyDefault)
    link.onContext = { [weak self] context in
      Task { @MainActor in self?.apply(context) }
    }
    link.activate()
    rebuildAPI()
  }

  var binding: ServerBinding? {
    guard let bindings else { return nil }
    let key = selectedKey ?? bindings.active
    return bindings.bindings.first { $0.storageKey == key }
      ?? bindings.bindings.first { $0.storageKey == bindings.active }
      ?? bindings.bindings.first
  }

  func row(_ id: Int) -> SessionRow? { rows.first { $0.id == id } }

  func setForeground(_ foreground: Bool) {
    pollTask?.cancel()
    pollTask = nil
    guard foreground else { return }
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(nanoseconds: Self.pollInterval)
      }
    }
  }

  func refresh() async {
    guard let api else {
      phase = .unpaired
      rows = []
      return
    }
    if rows.isEmpty, phase != .ready { phase = .loading }
    do {
      let sessions = try await api.sessions()
      let loaded = await withTaskGroup(of: SessionRow.self) { group in
        for session in sessions {
          group.addTask {
            // A failed history read degrades to "no prompt" for that row.
            let events = (try? await api.history(session.id, limit: 150)) ?? []
            return SessionRow(
              summary: session,
              pending: pendingInteraction(in: events),
              transcript: recentTranscript(in: events))
          }
        }
        var rows: [SessionRow] = []
        for await row in group { rows.append(row) }
        return rows
      }
      // Ignore results for a desktop the user switched away from meanwhile.
      guard api === self.api else { return }
      rows = loaded.sorted(by: Self.order)
      phase = .ready
      buzzForNewPrompts()
    } catch let error as APIError where error.isAuth {
      phase = .needsPhone("Sign-in expired. Open Kode on your iPhone to refresh it.")
      requestCredentials()
    } catch {
      phase = .failed(error.localizedDescription)
    }
  }

  func answer(sessionID: Int, questions: [PendingQuestion], choices: [String: Int]) async throws {
    guard let api else { return }
    for (index, question) in questions.enumerated() {
      guard let choice = choices[question.questionID] else { return }
      if question.source == "acp_permission", let requestID = question.requestID,
        let optionID = question.options[choice].optionID
      {
        try await api.structuredResponse(
          sessionID, requestID: requestID, response: ["optionId": optionID])
      } else {
        // Grouped answers go in order; the last one submits the form.
        try await api.answer(
          sessionID, questionID: question.questionID, choice: choice,
          submit: index == questions.count - 1)
      }
    }
    await refresh()
  }

  func respondToPlan(sessionID: Int, planID: String, accept: Bool) async throws {
    try await api?.planResponse(sessionID, planID: planID, accept: accept)
    await refresh()
  }

  func send(sessionID: Int, text: String) async throws {
    try await api?.sendText(sessionID, text: text)
    await refresh()
  }

  private func apply(_ context: [String: Any]) {
    guard let next = BindingSet(context: context) else { return }
    BindingVault.save(next)
    bindings = next
    if let selectedKey, !next.bindings.contains(where: { $0.storageKey == selectedKey }) {
      self.selectedKey = nil
    }
    rebuildAPI()
    if pollTask != nil { Task { await refresh() } }
  }

  private func rebuildAPI() {
    guard let binding else {
      api = nil
      rows = []
      phase = .unpaired
      return
    }
    // Token rotations reuse the desktop; only a different desktop resets.
    if api?.binding.storageKey != binding.storageKey { rows = [] }
    if api?.binding != binding {
      api = KodeAPI(binding: binding)
      phase = rows.isEmpty ? .loading : phase
    }
  }

  private func requestCredentials() {
    guard Date().timeIntervalSince(lastCredentialRequest) > 60 else { return }
    lastCredentialRequest = Date()
    link.requestCredentials()
  }

  private func buzzForNewPrompts() {
    let current = Set(rows.compactMap(\.pendingKey))
    if !current.subtracting(notifiedPending).isEmpty {
      WKInterfaceDevice.current().play(.notification)
    }
    notifiedPending = current
  }

  private static func order(_ a: SessionRow, _ b: SessionRow) -> Bool {
    if (a.pending != nil) != (b.pending != nil) { return a.pending != nil }
    let aBusy = a.summary.status == "busy"
    let bBusy = b.summary.status == "busy"
    if aBusy != bBusy { return aBusy }
    return a.id > b.id
  }
}

extension SessionRow {
  fileprivate var pendingKey: String? { pending.map { "\(id)/\($0.key)" } }
}

enum WKHaptics {
  static func success() { WKInterfaceDevice.current().play(.success) }
  static func failure() { WKInterfaceDevice.current().play(.failure) }
}
