import ExpoModulesCore
import VisionKit

// Local Expo module exposing VisionKit's DataScannerViewController as:
//   • isSupported() → device + OS capability (iOS 16, A12+)
//   • <DataScannerView recognizedTypes onItemTap /> → the live scanner view
// Deployment target is 16.1 (see expo-build-properties), so the 16.0+ APIs are
// always available at the call sites below.
public class ExpoDataScannerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoDataScanner")

    // isSupported / isAvailable are @MainActor-isolated on VisionKit, so read
    // them on the main actor (this AsyncFunction otherwise runs off-main).
    AsyncFunction("isSupported") { () async -> Bool in
      if #available(iOS 16.0, *) {
        return await MainActor.run {
          DataScannerViewController.isSupported && DataScannerViewController.isAvailable
        }
      }
      return false
    }

    View(ExpoDataScannerView.self) {
      Events("onItemTap", "onError", "onPhotoCaptured")

      Prop("recognizedTypes") { (view: ExpoDataScannerView, types: String) in
        view.setRecognizedTypes(types)
      }

      Prop("captureToken") { (view: ExpoDataScannerView, token: Int) in
        view.setCaptureToken(token)
      }
    }
  }
}
