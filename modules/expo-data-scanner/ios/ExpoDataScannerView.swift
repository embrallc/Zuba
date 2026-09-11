import ExpoModulesCore
import VisionKit
import UIKit

// An ExpoView that hosts a DataScannerViewController (live text + barcode/QR).
// Tap-to-select is the whole point: the delegate fires only when the user taps a
// recognized item, so irrelevant on-screen text is never captured. The scanner
// is contained in the nearest view controller (found via the responder chain)
// and started/stopped with the view's window membership. Deployment target is
// 16.1, so the iOS 16 APIs are available at every call site.
class ExpoDataScannerView: ExpoView {
  let onItemTap = EventDispatcher()
  let onError = EventDispatcher()
  let onPhotoCaptured = EventDispatcher()

  private var scanner: DataScannerViewController?
  private var recognizedTypes: String = "both"
  private var isContained = false
  private var isScanning = false
  private var lastCaptureToken = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    buildScanner()
  }

  func setRecognizedTypes(_ types: String) {
    let normalized = types.isEmpty ? "both" : types
    guard normalized != recognizedTypes else { return }
    recognizedTypes = normalized
    rebuild()
  }

  private func recognizedDataTypes() -> Set<DataScannerViewController.RecognizedDataType> {
    var set = Set<DataScannerViewController.RecognizedDataType>()
    if recognizedTypes == "text" || recognizedTypes == "both" { set.insert(.text()) }
    if recognizedTypes == "codes" || recognizedTypes == "both" { set.insert(.barcode()) }
    if set.isEmpty { set.insert(.text()) }
    return set
  }

  private func buildScanner() {
    let s = DataScannerViewController(
      recognizedDataTypes: recognizedDataTypes(),
      qualityLevel: .balanced,
      recognizesMultipleItems: true,
      isHighFrameRateTrackingEnabled: true,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
    )
    s.delegate = self
    scanner = s
    addSubview(s.view)
    s.view.frame = bounds
    s.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  private func containIfNeeded() {
    guard !isContained, let scanner = scanner, let parent = findViewController() else { return }
    parent.addChild(scanner)
    scanner.didMove(toParent: parent)
    isContained = true
  }

  private func startIfPossible() {
    guard let scanner = scanner, window != nil, !isScanning else { return }
    containIfNeeded()
    do {
      try scanner.startScanning()
      isScanning = true
    } catch {
      onError(["message": error.localizedDescription])
    }
  }

  private func stopScanningNow() {
    guard let scanner = scanner, isScanning else { return }
    scanner.stopScanning()
    isScanning = false
  }

  private func rebuild() {
    let wasActive = isScanning || window != nil
    stopScanningNow()
    if let scanner = scanner {
      scanner.willMove(toParent: nil)
      scanner.view.removeFromSuperview()
      scanner.removeFromParent()
    }
    isContained = false
    scanner = nil
    buildScanner()
    if wasActive { startIfPossible() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      startIfPossible()
    } else {
      stopScanningNow()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scanner?.view.frame = bounds
  }

  // Grab a high-res still of the current frame. Driven by a monotonically
  // increasing `captureToken` prop (a fresh value = capture now) so JS can
  // request a photo without an imperative view call; the saved file:// uri comes
  // back via onPhotoCaptured. capturePhoto() is @MainActor async throws (iOS 16+).
  func setCaptureToken(_ token: Int) {
    guard token != 0, token != lastCaptureToken, let scanner = scanner else { return }
    lastCaptureToken = token
    Task { @MainActor in
      do {
        let image = try await scanner.capturePhoto()
        if let uri = self.saveJPEG(image) {
          self.onPhotoCaptured(["uri": uri])
        } else {
          self.onError(["message": "Could not save scan photo"])
        }
      } catch {
        self.onError(["message": error.localizedDescription])
      }
    }
  }

  private func saveJPEG(_ image: UIImage) -> String? {
    guard let data = image.jpegData(compressionQuality: 0.9) else { return nil }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("scan_\(UUID().uuidString).jpg")
    do {
      try data.write(to: url)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  private func findViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let vc = current as? UIViewController { return vc }
      responder = current.next
    }
    return nil
  }

  // No deinit stop: a @MainActor class's deinit is nonisolated and can't call the
  // main-actor stopScanning(). Teardown is handled by didMoveToWindow(nil) when the
  // RN view unmounts, plus the scanner's own cleanup on dealloc.
}

extension ExpoDataScannerView: DataScannerViewControllerDelegate {
  func dataScanner(
    _ dataScanner: DataScannerViewController,
    didTapOn item: RecognizedItem
  ) {
    switch item {
    case .text(let text):
      onItemTap(["kind": "text", "value": text.transcript])
    case .barcode(let barcode):
      let value = barcode.payloadStringValue ?? ""
      let kind = (barcode.observation.symbology == .qr) ? "qr" : "barcode"
      onItemTap(["kind": kind, "value": value])
    @unknown default:
      break
    }
  }
}
