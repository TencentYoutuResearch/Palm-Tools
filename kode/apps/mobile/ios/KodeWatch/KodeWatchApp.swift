import SwiftUI

@main
struct KodeWatchApp: App {
  @StateObject private var store = WatchStore()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        SessionListView()
      }
      .environmentObject(store)
      .onChange(of: scenePhase, initial: true) { _, phase in
        store.setForeground(phase == .active)
      }
    }
  }
}
