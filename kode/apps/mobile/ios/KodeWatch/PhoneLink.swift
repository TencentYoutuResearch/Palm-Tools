import Foundation
import WatchConnectivity

/// Receives server bindings from the iPhone app (see Runner/WatchBridge.swift).
final class PhoneLink: NSObject, WCSessionDelegate {
  var onContext: (([String: Any]) -> Void)?

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  /// Asks the phone to refresh its account token and resend bindings. Sending
  /// a message wakes the iPhone app in the background when it is reachable.
  func requestCredentials() {
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else { return }
    session.sendMessage(["type": "credentials"], replyHandler: { _ in }, errorHandler: nil)
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    let context = session.receivedApplicationContext
    if !context.isEmpty { onContext?(context) }
  }

  func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
    onContext?(context)
  }
}
