import Foundation
import WatchKit

struct SessionRow: Identifiable {
  let summary: SessionSummary
  let pending: PendingInteraction?
  let transcript: [TranscriptLine]
  /// Every user message in the fetched window, to confirm watch sends.
  let userMessages: [TranscriptLine]
  let lastActivity: Date?
  var id: Int { summary.id }
  var busy: Bool { summary.status == "busy" }
}

/// Same lifecycle labels as the phone composer: Sent once the desktop
/// executed the input, Processed once the CLI transcript shows it.
enum OutboundStatus: Equatable {
  case sending
  case sent
  case failed(String)
}

struct OutboundMessage: Identifiable {
  let id = UUID()
  let sessionID: Int
  let text: String
  var status: OutboundStatus = .sending
  /// User message ids already in the transcript when this was sent; a new
  /// id with the same text is this message coming back from the CLI.
  let knownUserIDs: Set<String>
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
  @Published private(set) var outbound: [OutboundMessage] = []
  /// Rows grouped by working directory, in sticky activity order.
  @Published private(set) var folders: [FolderGroup] = []
  private var sessionOrder = StickyOrder()
  private var folderOrder = StickyOrder()
  /// Transcript lines that are watch sends confirmed by the CLI.
  @Published private(set) var processedLineIDs = Set<String>()
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
              transcript: recentTranscript(in: events),
              userMessages: userMessages(in: events),
              lastActivity: lastActivity(in: events))
          }
        }
        var rows: [SessionRow] = []
        for await row in group { rows.append(row) }
        return rows
      }
      // Ignore results for a desktop the user switched away from meanwhile.
      guard api === self.api else { return }
      rows = loaded
      folders = arrange(loaded)
      phase = .ready
      reconcileOutbound()
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

  func outbound(for sessionID: Int) -> [OutboundMessage] {
    outbound.filter { $0.sessionID == sessionID }
  }

  /// Queues the text and returns immediately; the bubble shows progress.
  func send(sessionID: Int, text: String) {
    let known = Set(row(sessionID)?.userMessages.map(\.id) ?? [])
    let message = OutboundMessage(sessionID: sessionID, text: text, knownUserIDs: known)
    outbound.append(message)
    deliver(message.id)
  }

  func retry(_ id: UUID) {
    guard let index = outbound.firstIndex(where: { $0.id == id }) else { return }
    outbound[index].status = .sending
    deliver(id)
  }

  func discard(_ id: UUID) {
    outbound.removeAll { $0.id == id }
  }

  private func deliver(_ id: UUID) {
    guard let api, let message = outbound.first(where: { $0.id == id }) else { return }
    Task {
      do {
        try await api.sendText(message.sessionID, text: message.text)
        update(id) { $0.status = .sent }
        WKHaptics.success()
        await refresh()
      } catch {
        update(id) { $0.status = .failed(error.localizedDescription) }
        WKHaptics.failure()
      }
    }
  }

  private func update(_ id: UUID, _ change: (inout OutboundMessage) -> Void) {
    guard let index = outbound.firstIndex(where: { $0.id == id }) else { return }
    change(&outbound[index])
  }

  /// Hands a sent bubble over to its transcript line once the CLI echoes it.
  private func reconcileOutbound() {
    var claimed = processedLineIDs
    outbound.removeAll { message in
      guard message.status == .sent, let row = row(message.sessionID) else { return false }
      let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard let line = row.userMessages.first(where: {
        !message.knownUserIDs.contains($0.id) && !claimed.contains($0.id) && $0.text == text
      }) else { return false }
      claimed.insert(line.id)
      return true
    }
    processedLineIDs = claimed
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

  private func arrange(_ rows: [SessionRow]) -> [FolderGroup] {
    let now = Date()
    let sessionRanks = Dictionary(
      uniqueKeysWithValues: rows.map { row in
        (
          row.id,
          sessionOrder.rank(
            "s\(row.id)", pending: row.pending != nil, busy: row.busy,
            lastActivity: row.lastActivity, now: now)
        )
      })
    sessionOrder.retain(Set(rows.map { "s\($0.id)" }))
    let groups = Dictionary(grouping: rows) { folderKey($0.summary.cwd) }
    let ranked = groups.map { key, members -> (StickyOrder.Rank, FolderGroup) in
      let sorted = members.sorted { sessionRanks[$0.id]! < sessionRanks[$1.id]! }
      let rank = folderOrder.rank(
        "f" + key,
        pending: members.contains { $0.pending != nil },
        busy: members.contains(where: \.busy),
        lastActivity: members.compactMap(\.lastActivity).max(),
        now: now)
      let cwd = sorted.first?.summary.cwd
      return (
        rank,
        FolderGroup(id: key, leaf: pathLeaf(cwd), parent: pathParent(cwd), rows: sorted)
      )
    }
    folderOrder.retain(Set(groups.keys.map { "f" + $0 }))
    return ranked.sorted { $0.0 < $1.0 }.map(\.1)
  }
}

extension SessionRow {
  fileprivate var pendingKey: String? { pending.map { "\(id)/\($0.key)" } }
}

enum WKHaptics {
  static func success() { WKInterfaceDevice.current().play(.success) }
  static func failure() { WKInterfaceDevice.current().play(.failure) }
}
