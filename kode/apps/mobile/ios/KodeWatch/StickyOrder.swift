import Foundation

/// Orders folders and sessions by recent activity without reshuffling the
/// list every time an agent flips between busy and idle.
///
/// Tiers: waiting on an approval, then active (busy, or any activity within
/// `activeWindow`), then the rest by last activity. Inside the first two
/// tiers an item keeps the time it *entered* the tier, so it only moves when
/// it changes tier, never because a neighbour printed one more line. An item
/// that goes quiet drops to the top of the last tier, right below the
/// actives, so the move is barely visible.
struct StickyOrder {
  static let activeWindow: TimeInterval = 10 * 60

  struct Rank: Comparable {
    let tier: Int
    let since: Date
    let key: String

    static func < (a: Rank, b: Rank) -> Bool {
      if a.tier != b.tier { return a.tier < b.tier }
      if a.since != b.since { return a.since > b.since }
      return a.key < b.key
    }
  }

  private var pendingSince: [String: Date] = [:]
  private var activeSince: [String: Date] = [:]

  mutating func rank(
    _ key: String, pending: Bool, busy: Bool, lastActivity: Date?, now: Date
  ) -> Rank {
    let recent = lastActivity.map { now.timeIntervalSince($0) < Self.activeWindow } ?? false
    let active = busy || recent
    if active {
      // Entering the tier counts from the activity that caused it, so a
      // folder that was already busy when the app opened keeps its place.
      activeSince[key] = activeSince[key] ?? min(lastActivity ?? now, now)
    } else {
      activeSince[key] = nil
    }
    if pending {
      pendingSince[key] = pendingSince[key] ?? now
      return Rank(tier: 0, since: pendingSince[key]!, key: key)
    }
    pendingSince[key] = nil
    if let since = activeSince[key] {
      return Rank(tier: 1, since: since, key: key)
    }
    return Rank(tier: 2, since: lastActivity ?? .distantPast, key: key)
  }

  /// Forgets items that disappeared (closed sessions, another desktop).
  mutating func retain(_ keys: Set<String>) {
    pendingSince = pendingSince.filter { keys.contains($0.key) }
    activeSince = activeSince.filter { keys.contains($0.key) }
  }
}

/// Latest moment the session visibly did something. Receipts and metadata
/// are bookkeeping, not activity.
func lastActivity(in events: [KodeEvent]) -> Date? {
  let ignored: Set<String> = ["command.status", "meta", "session.status"]
  let latest = events.lazy.filter { !ignored.contains($0.type) }.map(\.ts).max()
  return latest.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
}
