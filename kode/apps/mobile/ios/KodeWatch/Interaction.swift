import Foundation

struct ChoiceOption {
  let label: String
  let detail: String?
  /// ACP permission option id; nil for terminal prompts answered by index.
  let optionID: String?
}

struct PendingQuestion {
  let questionID: String
  let requestID: String?
  let source: String?
  let text: String
  let context: String?
  let options: [ChoiceOption]
}

enum PendingInteraction {
  case questions([PendingQuestion])
  case plan(id: String, markdown: String)
  /// Typed ACP forms need the full phone UI.
  case phoneOnly(String)

  /// Stable identity used to buzz once per new prompt.
  var key: String {
    switch self {
    case .questions(let questions): return "q:" + (questions.first?.questionID ?? "")
    case .plan(let id, _): return "p:" + id
    case .phoneOnly(let id): return "f:" + id
    }
  }
}

/// Bridge expands one AskUserQuestion call into `call-0`, `call-1`, …; they
/// are answered as one group. PTY/ACP prompts are always standalone.
/// Mirrors `askQuestionGroupId` in lib/src/protocol/protocol.dart.
func questionGroupID(_ id: String) -> String {
  if id.hasPrefix("pty-") || id.hasPrefix("acp-") { return id }
  guard let dash = id.lastIndex(of: "-"), Int(id[id.index(after: dash)...]) != nil else {
    return id
  }
  return String(id[..<dash])
}

/// The newest ask / plan / attention-cleared event decides whether the
/// session is waiting on the user — the same rule as the bridge's
/// `pending_interaction`, plus ACP `interaction.resolved` receipts.
func pendingInteraction(in events: [KodeEvent]) -> PendingInteraction? {
  let resolved = Set(
    events.filter { $0.type == "interaction.resolved" }
      .compactMap { $0.payload["request_id"] as? String })
  let markers: Set<String> = ["ask_user_question", "plan_proposed", "session.attention_cleared"]
  guard let lastIndex = events.lastIndex(where: { markers.contains($0.type) }) else { return nil }
  let last = events[lastIndex]

  switch last.type {
  case "plan_proposed":
    let id = last.payload["plan_id"] as? String ?? "?"
    if resolved.contains(id) { return nil }
    return .plan(id: id, markdown: last.payload["plan_md"] as? String ?? "")
  case "ask_user_question":
    let source = last.payload["source"] as? String
    if let requestID = last.payload["request_id"] as? String, resolved.contains(requestID) {
      return nil
    }
    if source == "acp_form" || source == "acp_questions" {
      return .phoneOnly(last.payload["request_id"] as? String ?? "\(last.ts)")
    }
    let group = questionGroupID(last.payload["question_id"] as? String ?? "")
    let clearedIndex = events[..<lastIndex].lastIndex { $0.type == "session.attention_cleared" }
    let start = clearedIndex.map { $0 + 1 } ?? 0
    var seen = Set<String>()
    let questions = events[start...lastIndex]
      .filter {
        $0.type == "ask_user_question"
          && questionGroupID($0.payload["question_id"] as? String ?? "") == group
      }
      .compactMap { event -> PendingQuestion? in
        let id = event.payload["question_id"] as? String ?? "q-\(event.ts)"
        // History may replay the same prompt; keep the first occurrence.
        guard seen.insert(id).inserted else { return nil }
        return question(from: event.payload, id: id)
      }
    return questions.isEmpty ? nil : .questions(questions)
  default:
    return nil
  }
}

private func question(from payload: [String: Any], id: String) -> PendingQuestion {
  let options = (payload["options"] as? [[String: Any]] ?? []).map {
    ChoiceOption(
      label: $0["label"] as? String ?? "?",
      detail: $0["description"] as? String,
      optionID: $0["option_id"] as? String)
  }
  let context = (payload["context"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
  return PendingQuestion(
    questionID: id,
    requestID: payload["request_id"] as? String,
    source: payload["source"] as? String,
    text: payload["question"] as? String ?? "",
    context: context?.isEmpty == false ? context : nil,
    options: options)
}

struct TranscriptLine: Identifiable {
  let id: String
  let role: String
  let text: String
}

/// Recent user/assistant messages for the glanceable session view.
func recentTranscript(in events: [KodeEvent], limit: Int = 10) -> [TranscriptLine] {
  var lines: [TranscriptLine] = []
  var index: [String: Int] = [:]
  for event in events where event.type == "message" {
    let role = event.payload["role"] as? String ?? "assistant"
    guard role == "user" || role == "assistant",
      let text = (event.payload["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !text.isEmpty
    else { continue }
    let id = event.payload["id"] as? String ?? "m-\(event.ts)-\(lines.count)"
    let line = TranscriptLine(id: id, role: role, text: text)
    // A message id seen again is an update of the same bubble.
    if let existing = index[id] {
      lines[existing] = line
    } else {
      index[id] = lines.count
      lines.append(line)
    }
  }
  return Array(lines.suffix(limit))
}

/// All user messages in the window, oldest first.
func userMessages(in events: [KodeEvent]) -> [TranscriptLine] {
  recentTranscript(in: events, limit: .max).filter { $0.role == "user" }
}
