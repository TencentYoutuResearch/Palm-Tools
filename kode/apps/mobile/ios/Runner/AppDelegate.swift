import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private let appChannelName = "kode/app"

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(
      forPlugin: "KodeAppChannel"
    ) else {
      return
    }
    let channel = FlutterMethodChannel(
      name: appChannelName,
      binaryMessenger: registrar.messenger()
    )
    channel.setMethodCallHandler(handleAppMethod)
  }

  private func handleAppMethod(
    call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    switch call.method {
    case "prepareNetworkAccess":
      guard let url = URL(string: "https://captive.apple.com/hotspot-detect.html") else {
        result(false)
        return
      }
      var request = URLRequest(url: url)
      request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
      request.timeoutInterval = 5
      URLSession.shared.dataTask(with: request) { _, response, error in
        DispatchQueue.main.async {
          result(error == nil && response != nil)
        }
      }.resume()
    case "openSettings":
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        result(false)
        return
      }
      UIApplication.shared.open(url, options: [:]) { success in
        result(success)
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
