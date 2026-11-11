import SwiftUI
import WatchKit

struct SessionView: View {
  let sessionID: Int
  @EnvironmentObject private var store: WatchStore

  var body: some View {
    let row = store.row(sessionID)
    List {
      if let row {
        switch row.pending {
        case .questions(let questions):
          QuestionApprovalView(sessionID: sessionID, questions: questions)
            // A new prompt must not inherit the previous prompt's selection.
            .id(row.pending?.key)
        case .plan(let planID, let markdown):
          PlanApprovalView(sessionID: sessionID, planID: planID, markdown: markdown)
            .id(planID)
        case .phoneOnly:
          Label("This form needs the iPhone app.", systemImage: "iphone")
            .font(.footnote)
            .foregroundStyle(.orange)
        case nil:
          VoiceComposer(sessionID: sessionID)
        }
        Section {
          ForEach(row.transcript.reversed()) { line in
            Text(line.text)
              .font(.caption2)
              .lineLimit(line.role == "user" ? 3 : 8)
              .foregroundStyle(line.role == "user" ? Color.accentColor : .primary)
          }
        } header: {
          Text(row.summary.status == "busy" ? "Working…" : "Recent")
        }
      } else {
        Text("This session is no longer running.")
          .foregroundStyle(.secondary)
      }
    }
    .navigationTitle(row?.summary.displayTitle ?? "Session")
  }
}

struct QuestionApprovalView: View {
  let sessionID: Int
  let questions: [PendingQuestion]
  @EnvironmentObject private var store: WatchStore
  @State private var choices: [String: Int] = [:]
  @State private var submitting = false
  @State private var error: String?

  var body: some View {
    ForEach(questions, id: \.questionID) { question in
      Section {
        if let context = question.context {
          Text(context)
            .font(.system(.caption2, design: .monospaced))
            .lineLimit(10)
        }
        ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
          Button {
            choices[question.questionID] = index
          } label: {
            HStack(alignment: .top) {
              Image(
                systemName: choices[question.questionID] == index
                  ? "checkmark.circle.fill" : "circle")
              VStack(alignment: .leading) {
                Text(option.label)
                if let detail = option.detail {
                  Text(detail).font(.caption2).foregroundStyle(.secondary)
                }
              }
            }
          }
          .disabled(submitting)
        }
      } header: {
        Text(question.text)
          .font(.footnote)
          .textCase(nil)
      }
    }
    if let error {
      Text(error).font(.footnote).foregroundStyle(.red)
    }
    Button {
      Task { await submit() }
    } label: {
      if submitting {
        ProgressView()
      } else {
        Text("Submit")
      }
    }
    .tint(.accentColor)
    .disabled(submitting || !complete)
  }

  private var complete: Bool {
    questions.allSatisfy { choices[$0.questionID] != nil }
  }

  private func submit() async {
    submitting = true
    error = nil
    defer { submitting = false }
    do {
      try await store.answer(sessionID: sessionID, questions: questions, choices: choices)
      WKHaptics.success()
    } catch {
      self.error = error.localizedDescription
      WKHaptics.failure()
    }
  }
}

struct PlanApprovalView: View {
  let sessionID: Int
  let planID: String
  let markdown: String
  @EnvironmentObject private var store: WatchStore
  @State private var submitting = false
  @State private var error: String?

  var body: some View {
    Section {
      Text(planText)
        .font(.caption2)
        .lineLimit(14)
      if let error {
        Text(error).font(.footnote).foregroundStyle(.red)
      }
      Button("Accept") { Task { await respond(true) } }
        .tint(.green)
        .disabled(submitting)
      Button("Reject", role: .destructive) { Task { await respond(false) } }
        .disabled(submitting)
    } header: {
      Text("Review the plan").textCase(nil)
    }
  }

  private var planText: AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: markdown, options: options))
      ?? AttributedString(markdown)
  }

  private func respond(_ accept: Bool) async {
    submitting = true
    error = nil
    defer { submitting = false }
    do {
      try await store.respondToPlan(sessionID: sessionID, planID: planID, accept: accept)
      WKHaptics.success()
    } catch {
      self.error = error.localizedDescription
      WKHaptics.failure()
    }
  }
}

/// Dictation goes into an editable draft; nothing is sent until Send is
/// tapped, matching the phone composer.
struct VoiceComposer: View {
  let sessionID: Int
  @EnvironmentObject private var store: WatchStore
  @State private var draft = ""
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    Section {
      Button {
        dictate()
      } label: {
        Label(trimmed.isEmpty ? "Speak" : "Speak again", systemImage: "mic.fill")
      }
      .disabled(sending)
      if !trimmed.isEmpty {
        // The transcript stays editable (tap to fix with keyboard/Scribble).
        TextField("Message", text: $draft, axis: .vertical)
          .disabled(sending)
        Button {
          Task { await send() }
        } label: {
          if sending {
            ProgressView()
          } else {
            Label("Send", systemImage: "arrow.up.circle.fill")
          }
        }
        .tint(.accentColor)
        .disabled(sending)
      }
      if let error {
        Text(error).font(.footnote).foregroundStyle(.red)
      }
    }
  }

  /// SwiftUI has no dictation API on watchOS. WatchKit's text input
  /// controller with no suggestions and plain mode skips the suggestion list;
  /// watches with a keyboard still open on the keyboard first.
  private func dictate() {
    guard let controller = WKApplication.shared().visibleInterfaceController else {
      error = "Dictation is unavailable here."
      return
    }
    controller.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) {
      results in
      guard let text = results?.compactMap({ $0 as? String }).joined(separator: " "),
        !text.isEmpty
      else { return }
      DispatchQueue.main.async {
        error = nil
        draft = trimmed.isEmpty ? text : trimmed + " " + text
      }
    }
  }

  private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

  private func send() async {
    let text = trimmed
    guard !text.isEmpty else { return }
    sending = true
    error = nil
    defer { sending = false }
    do {
      try await store.send(sessionID: sessionID, text: text)
      draft = ""
      WKHaptics.success()
    } catch {
      self.error = error.localizedDescription
      WKHaptics.failure()
    }
  }
}
