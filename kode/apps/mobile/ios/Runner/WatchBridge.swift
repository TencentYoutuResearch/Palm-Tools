import Flutter
import WatchConnectivity

/// Relays server bindings from Flutter to the Apple Watch companion.
///
/// Flutter pushes the full binding list on every change; the latest value
/// replaces the watch's copy through the application context. The watch asks
/// for a resend (with a fresh account token) when the server rejects its copy.
final class WatchBridge: NSObject, WCSessionDelegate {
  private let channel: FlutterMethodChannel
  private var pendingContext: [String: Any]?

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "kode/watch", binaryMessenger: messenger)
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call: call, result: result)
    }
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  private func handle(call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "updateContext":
      guard let context = call.arguments as? [String: Any] else {
        result(FlutterError(code: "bad_args", message: "context must be a map", details: nil))
        return
      }
      pendingContext = context
      flush()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func flush() {
    guard WCSession.isSupported(), let context = pendingContext else { return }
    let session = WCSession.default
    // Context updates fail before activation or without a paired watch app;
    // keep the latest copy and retry once the session becomes usable.
    guard session.activationState == .activated, session.isPaired,
      session.isWatchAppInstalled
    else { return }
    do {
      try session.updateApplicationContext(context)
      pendingContext = nil
    } catch {
      NSLog("[watch] updateApplicationContext failed: \(error.localizedDescription)")
    }
  }

  // MARK: WCSessionDelegate

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    DispatchQueue.main.async { self.flush() }
  }

  func sessionWatchStateDidChange(_ session: WCSession) {
    DispatchQueue.main.async { self.flush() }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    // Switching paired watches deactivates the old session; reactivate.
    session.activate()
  }

  func session(
    _ session: WCSession,
    didReceiveMessage message: [String: Any],
    replyHandler: @escaping ([String: Any]) -> Void
  ) {
    guard message["type"] as? String == "credentials" else {
      replyHandler(["ok": false])
      return
    }
    DispatchQueue.main.async {
      self.channel.invokeMethod("credentialsRequested", arguments: nil)
      replyHandler(["ok": true])
    }
  }
}
