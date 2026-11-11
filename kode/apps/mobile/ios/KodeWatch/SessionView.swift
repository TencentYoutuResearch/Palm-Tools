import SwiftUI
import WatchKit

struct SessionView: View {
  let sessionID: Int
  @EnvironmentObject private var store: WatchStore
  @State private var dictationError: String?

  var body: some View {
    let row = store.row(sessionID)
    let outbound = store.outbound(for: sessionID)
    ScrollViewReader { proxy in
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
            EmptyView()
          }
          // Oldest first, like the phone transcript; the view opens at the end.
          ForEach(row.transcript) { line in
            if line.role == "user" {
              UserBubble(
                text: line.text,
                status: store.processedLineIDs.contains(line.id) ? .processed : nil)
            } else {
              AgentBubble(text: line.text)
            }
          }
          ForEach(outbound) { message in
            UserBubble(text: message.text, status: .outbound(message.status))
              .onTapGesture {
                if case .failed = message.status { store.retry(message.id) }
              }
              .swipeActions {
                Button("Discard", role: .destructive) { store.discard(message.id) }
              }
          }
          if row.summary.status == "busy" {
            HStack(spacing: 6) {
              ProgressView().frame(width: 16, height: 16)
              Text("Working…").font(.caption2).foregroundStyle(.secondary)
            }
            .listRowBackground(Color.clear)
          }
          if let dictationError {
            Text(dictationError).font(.footnote).foregroundStyle(.red)
              .listRowBackground(Color.clear)
          }
          // Scroll anchor that stays above the pinned microphone.
          Color.clear.frame(height: 1)
            .listRowBackground(Color.clear)
            .id(Self.bottomID)
        } else {
          Text("This session is no longer running.")
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle(row?.summary.displayTitle ?? "Session")
      .toolbar {
        // Pinned so the microphone is reachable however long the chat is.
        if row != nil, row?.pending == nil {
          ToolbarItemGroup(placement: .bottomBar) {
            Spacer()
            Button {
              dictate()
            } label: {
              Image(systemName: "mic.fill")
            }
            .tint(.accentColor)
            .accessibilityLabel("Speak a message")
          }
        }
      }
      .onAppear { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
      .onChange(of: row?.transcript.last?.id) { _, _ in
        withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
      }
      .onChange(of: outbound.count) { _, _ in
        withAnimation { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
      }
    }
  }

  private static let bottomID = "bottom"

  /// SwiftUI has no dictation API on watchOS. WatchKit's text input
  /// controller with no suggestions and plain mode skips the suggestion list;
  /// watches with a keyboard still open on the keyboard first.
  private func dictate() {
    guard let controller = WKApplication.shared().visibleInterfaceController else {
      dictationError = "Dictation is unavailable here."
      return
    }
    controller.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) {
      results in
      let text = (results ?? []).compactMap { $0 as? String }.joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return }
      DispatchQueue.main.async {
        dictationError = nil
        store.send(sessionID: sessionID, text: text)
      }
    }
  }
}

/// Delivery label under a user bubble, mirroring the phone composer.
enum BubbleStatus {
  case outbound(OutboundStatus)
  case processed
}

private struct UserBubble: View {
  let text: String
  let status: BubbleStatus?

  var body: some View {
    VStack(alignment: .trailing, spacing: 2) {
      Text(text)
        .font(.footnote)
        .foregroundStyle(.black)
        .lineLimit(6)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(failed ? Color.red.opacity(0.85) : Color.accentColor, in: bubbleShape)
      if let label {
        HStack(spacing: 3) {
          if case .outbound(.sending) = status {
            ProgressView().frame(width: 10, height: 10).scaleEffect(0.5)
          } else {
            Image(systemName: label.icon)
          }
          Text(label.text)
        }
        .font(.system(size: 10))
        .foregroundStyle(failed ? .red : .secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 18)
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 2, leading: 4, bottom: 2, trailing: 4))
  }

  private var bubbleShape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(
      topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 4,
      topTrailingRadius: 14)
  }

  private var failed: Bool {
    if case .outbound(.failed) = status { return true }
    return false
  }

  private var label: (icon: String, text: String)? {
    switch status {
    case .outbound(.sending): return ("", "Sending…")
    case .outbound(.sent): return ("checkmark", "Sent")
    case .outbound(.failed): return ("exclamationmark.circle", "Not sent · Tap to retry")
    case .processed: return ("checkmark.circle.fill", "Processed")
    case nil: return nil
    }
  }
}

private struct AgentBubble: View {
  let text: String

  var body: some View {
    Text(markdown)
      .font(.footnote)
      .lineLimit(12)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(
        Color.gray.opacity(0.25),
        in: UnevenRoundedRectangle(
          topLeadingRadius: 14, bottomLeadingRadius: 4, bottomTrailingRadius: 14,
          topTrailingRadius: 14)
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.trailing, 12)
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets(top: 2, leading: 4, bottom: 2, trailing: 4))
  }

  private var markdown: AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
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
