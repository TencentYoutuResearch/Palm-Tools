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
          ForEach(store.folders) { group in
            Section {
              ForEach(group.rows) { row in
                NavigationLink(value: row.id) {
                  SessionRowView(row: row)
                }
              }
            } header: {
              FolderHeader(group: group)
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

/// Sessions sharing one working directory, like the phone's path groups
/// (`_buildGroups` in lib/src/ui/sessions/sessions_screen.dart). Ordered by
/// `StickyOrder` instead of name so active folders stay on top.
struct FolderGroup: Identifiable {
  let id: String
  let leaf: String
  let parent: String
  let rows: [SessionRow]
  var pendingCount: Int { rows.filter { $0.pending != nil }.count }
}

func folderKey(_ path: String?) -> String {
  guard let raw = path?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return "__unset__" }
  return raw.replacingOccurrences(of: "\\", with: "/")
}

func pathLeaf(_ path: String?) -> String {
  guard let path, !path.trimmingCharacters(in: .whitespaces).isEmpty else { return "workspace unset" }
  let parts = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/")
  return parts.last.map(String.init) ?? path
}

func pathParent(_ path: String?) -> String {
  guard let path, !path.trimmingCharacters(in: .whitespaces).isEmpty else { return "No working directory" }
  let normalized = path.replacingOccurrences(of: "\\", with: "/")
  guard let slash = normalized.lastIndex(of: "/"), slash > normalized.startIndex else { return normalized }
  return String(normalized[..<slash])
}

private struct FolderHeader: View {
  let group: FolderGroup

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 4) {
        Image(systemName: "folder.fill")
        Text(group.leaf).lineLimit(1)
        Spacer(minLength: 2)
        if group.pendingCount > 0 {
          Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        }
        Text("\(group.rows.count)").foregroundStyle(.secondary)
      }
      .font(.footnote.weight(.semibold))
      Text(abbreviatedParent)
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.head)
    }
    .textCase(nil)
  }

  /// `/Users/<name>/…` reads as `~/…`, as on the desktop.
  private var abbreviatedParent: String {
    let parts = group.parent.split(separator: "/", omittingEmptySubsequences: false)
    if parts.count >= 3, parts[0].isEmpty, parts[1] == "Users" || parts[1] == "home" {
      return (["~"] + parts.dropFirst(3)).joined(separator: "/")
    }
    return group.parent
  }
}
