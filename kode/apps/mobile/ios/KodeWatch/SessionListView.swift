import SwiftUI

struct SessionListView: View {
  @EnvironmentObject private var store: WatchStore

  var body: some View {
    Group {
      if store.binding == nil {
        ContentUnavailableView(
          "Open Kode on iPhone",
          systemImage: "iphone",
          description: Text("Pair a desktop or sign in on your iPhone. The watch picks it up automatically.")
        )
      } else {
        List {
          if store.bindings?.bindings.count ?? 0 > 1 {
            NavigationLink {
              DesktopPickerView()
            } label: {
              Label(store.binding?.displayName ?? "Desktop", systemImage: "desktopcomputer")
                .font(.footnote)
            }
          }
          statusSection
          ForEach(store.rows) { row in
            NavigationLink(value: row.id) {
              SessionRowView(row: row)
            }
          }
        }
        .refreshable { await store.refresh() }
      }
    }
    .navigationTitle("Kode")
    .navigationDestination(for: Int.self) { id in
      SessionView(sessionID: id)
    }
  }

  @ViewBuilder
  private var statusSection: some View {
    switch store.phase {
    case .loading:
      HStack {
        ProgressView()
        Text("Loading…").foregroundStyle(.secondary)
      }
    case .needsPhone(let message), .failed(let message):
      Text(message)
        .font(.footnote)
        .foregroundStyle(.orange)
    case .ready where store.rows.isEmpty:
      Text("No running sessions.")
        .foregroundStyle(.secondary)
    default:
      EmptyView()
    }
  }
}

private struct SessionRowView: View {
  let row: SessionRow

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Circle()
          .fill(statusColor)
          .frame(width: 7, height: 7)
        Text(row.summary.displayTitle)
          .font(.headline)
          .lineLimit(1)
      }
      if row.pending != nil {
        Label("Needs approval", systemImage: "hand.raised.fill")
          .font(.caption)
          .foregroundStyle(.orange)
      } else if let last = row.transcript.last {
        Text(last.text)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      } else {
        Text(row.summary.backendKey)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var statusColor: Color {
    if row.pending != nil { return .orange }
    return row.summary.status == "busy" ? .green : .gray
  }
}

private struct DesktopPickerView: View {
  @EnvironmentObject private var store: WatchStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List(store.bindings?.bindings ?? []) { binding in
      Button {
        store.selectedKey = binding.storageKey
        dismiss()
      } label: {
        HStack {
          Text(binding.displayName)
          Spacer()
          if binding.storageKey == store.binding?.storageKey {
            Image(systemName: "checkmark")
          }
        }
      }
    }
    .navigationTitle("Desktop")
  }
}
