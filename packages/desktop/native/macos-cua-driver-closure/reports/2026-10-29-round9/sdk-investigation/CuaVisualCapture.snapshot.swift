// Narrow single-window ScreenCaptureKit completion bridge.
//
// Derived from the fixed `screencapturekit 8.0.1` Swift bridge at git
// 2a9f13bcbeadb0aabc5596f0ff3d2ba71da8c1d0. The upstream MIT/Apache-2.0
// license texts are retained under `native/licenses/`. See `DERIVATION.md`
// for the exact source files, hashes and omitted wrapper/streaming behavior.

import CoreGraphics
import CoreVideo
import Foundation
import ScreenCaptureKit

private enum CuaVisualStatus: Int32 {
    case success = 0
    case canceled = 1
    case admissionRejected = 2
    case windowNotFound = 3
    case enumerationFailed = 4
    case captureFailed = 5
    case imageInvalid = 6
}

private struct CuaSelectedWindow {
    let windowID: UInt32
    let pid: Int32
    let layer: Int32
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

public typealias CuaAdmissionCallback = @convention(c) (
    UInt64, UInt32, Int32, Int32, Double, Double, Double, Double
) -> Int32

public typealias CuaCompletionCallback = @convention(c) (
    UInt64, Int32, UInt32, Int32, Int32, Double, Double, Double, Double,
    UInt32, UInt32, UnsafePointer<UInt8>?, Int
) -> Void

public typealias CuaPayloadReleasedCallback = @convention(c) (UInt64) -> Void

private final class RGBABuffer {
    private var pointer: UnsafeMutableRawPointer?
    let count: Int

    init(pointer: UnsafeMutableRawPointer, count: Int) {
        self.pointer = pointer
        self.count = count
    }

    func withUnsafePointer(_ body: (UnsafePointer<UInt8>) -> Void) {
        guard let pointer else { return }
        body(pointer.assumingMemoryBound(to: UInt8.self))
    }

    /// Explicitly drops the bridge-owned pixels before capacity is released.
    func release() {
        pointer?.deallocate()
        pointer = nil
    }

    deinit {
        release()
    }
}

private final class LifecycleGate {
    private let lock = NSLock()
    private var enumerationClaimed = false
    private var admissionClaimed = false
    private var captureClaimed = false
    private var terminal = false

    func claimEnumeration() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !enumerationClaimed else { return false }
        enumerationClaimed = true
        return true
    }

    func claimAdmission() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !admissionClaimed else { return false }
        admissionClaimed = true
        return true
    }

    func claimCapture() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard admissionClaimed, !captureClaimed else { return false }
        captureClaimed = true
        return true
    }

    func claimTerminal() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !terminal else { return false }
        terminal = true
        return true
    }
}

private func emit(
    gate: LifecycleGate,
    requestID: UInt64,
    completion: CuaCompletionCallback,
    payloadReleased: CuaPayloadReleasedCallback,
    status: CuaVisualStatus,
    selected: CuaSelectedWindow?,
    width: UInt32 = 0,
    height: UInt32 = 0,
    rgba: RGBABuffer? = nil
) {
    guard gate.claimTerminal() else { return }
    let windowID = selected?.windowID ?? 0
    let pid = selected?.pid ?? 0
    let layer = selected?.layer ?? 0
    let x = selected?.x ?? 0
    let y = selected?.y ?? 0
    let frameWidth = selected?.width ?? 0
    let frameHeight = selected?.height ?? 0
    if let rgba {
        rgba.withUnsafePointer { pointer in
            completion(
                requestID,
                status.rawValue,
                windowID,
                pid,
                layer,
                x,
                y,
                frameWidth,
                frameHeight,
                width,
                height,
                pointer,
                rgba.count
            )
        }
        // The only bridge-owned pixel allocation is gone before the release
        // notification. This does not assert that the OS callback thread or
        // ScreenCaptureKit has returned to an idle/fenced/drained state.
        rgba.release()
    } else {
        completion(
            requestID,
            status.rawValue,
            windowID,
            pid,
            layer,
            x,
            y,
            frameWidth,
            frameHeight,
            width,
            height,
            nil,
            0
        )
    }
    payloadReleased(requestID)
}

private func checkedPixelExtent(_ value: Double, maxSide: Int) -> UInt32? {
    guard value.isFinite, value > 0 else { return nil }
    let rounded = value.rounded()
    guard rounded >= 1, rounded <= Double(maxSide) else { return nil }
    return UInt32(rounded)
}

private func renderRGBA(
    image: CGImage,
    maxSide: Int,
    maxBytes: Int
) -> RGBABuffer? {
    let width = image.width
    let height = image.height
    guard width > 0, height > 0, width <= maxSide, height <= maxSide else {
        return nil
    }
    let (bytesPerRow, rowOverflow) = width.multipliedReportingOverflow(by: 4)
    let (totalBytes, totalOverflow) = height.multipliedReportingOverflow(by: bytesPerRow)
    guard !rowOverflow, !totalOverflow, totalBytes > 0, totalBytes <= maxBytes else {
        return nil
    }

    let pointer = UnsafeMutableRawPointer.allocate(
        byteCount: totalBytes,
        alignment: MemoryLayout<UInt8>.alignment
    )
    pointer.initializeMemory(as: UInt8.self, repeating: 0, count: totalBytes)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    // The R8 CGImage conversion also produced premultiplied RGBA. The PNG
    // encoder writes these bytes as-is; transparency is not un-premultiplied.
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    guard let context = CGContext(
            data: pointer,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo.rawValue
        ) else {
        pointer.deallocate()
        return nil
    }
    context.setBlendMode(.copy)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return RGBABuffer(pointer: pointer, count: totalBytes)
}

@_cdecl("cua_visual_capture_window")
public func cuaVisualCaptureWindow(
    requestID: UInt64,
    windowID: UInt32,
    admission: CuaAdmissionCallback,
    completion: CuaCompletionCallback,
    payloadReleased: CuaPayloadReleasedCallback,
    maxSide: UInt32,
    maxRGBABytes: UInt64
) -> Int32 {
    guard maxSide > 0, maxSide <= UInt32(Int32.max) else { return -1 }
    guard let maxBytes = Int(exactly: maxRGBABytes), maxBytes > 0 else {
        return -1
    }
    let maxSideInt = Int(maxSide)
    let gate = LifecycleGate()

    func finish(
        _ status: CuaVisualStatus,
        selected: CuaSelectedWindow?,
        width: UInt32 = 0,
        height: UInt32 = 0,
        rgba: RGBABuffer? = nil
    ) {
        emit(
            gate: gate,
            requestID: requestID,
            completion: completion,
            payloadReleased: payloadReleased,
            status: status,
            selected: selected,
            width: width,
            height: height,
            rgba: rgba
        )
    }

    // The completion-handler form avoids introducing a Swift concurrency Task
    // solely for this one-shot bridge. All error paths terminate through the
    // same once gate, so an OS duplicate cannot call Rust twice.
    SCShareableContent.getExcludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
    ) { content, error in
        // A framework duplicate callback must not enter admission a second
        // time and terminalize an operation while the first capture is in
        // flight.
        guard gate.claimEnumeration() else { return }
        guard error == nil, let content else {
            finish(.enumerationFailed, selected: nil)
            return
        }
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            finish(.windowNotFound, selected: nil)
            return
        }
        guard let application = window.owningApplication,
              let layer = Int32(exactly: window.windowLayer) else {
            finish(.admissionRejected, selected: nil)
            return
        }
        let frame = window.frame
        let selected = CuaSelectedWindow(
            windowID: window.windowID,
            pid: application.processID,
            layer: layer,
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height
        )

        guard gate.claimAdmission() else { return }
        let decision = admission(
            requestID,
            selected.windowID,
            selected.pid,
            selected.layer,
            selected.x,
            selected.y,
            selected.width,
            selected.height
        )
        if decision == 1 {
            finish(.canceled, selected: selected)
            return
        }
        guard decision == 0 else {
            finish(.admissionRejected, selected: selected)
            return
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = Double(filter.pointPixelScale)
        let contentRect = filter.contentRect
        let contentWidth = contentRect.width
        let contentHeight = contentRect.height
        let contentRectUsable = contentWidth.isFinite && contentWidth > 0
            && contentHeight.isFinite && contentHeight > 0
        let pointsWidth = contentRectUsable ? contentWidth : frame.size.width
        let pointsHeight = contentRectUsable ? contentHeight : frame.size.height
        guard let outputWidth = checkedPixelExtent(pointsWidth * scale, maxSide: maxSideInt),
              let outputHeight = checkedPixelExtent(pointsHeight * scale, maxSide: maxSideInt) else {
            finish(.imageInvalid, selected: selected)
            return
        }
        let (pixels, pixelOverflow) = UInt64(outputWidth).multipliedReportingOverflow(
            by: UInt64(outputHeight)
        )
        let maxPixels = UInt64(maxBytes / 4)
        let (rgbaBytes, byteOverflow) = pixels.multipliedReportingOverflow(by: 4)
        guard !pixelOverflow, !byteOverflow, pixels > 0, pixels <= maxPixels,
              rgbaBytes <= UInt64(maxBytes) else {
            finish(.imageInvalid, selected: selected)
            return
        }

        let configuration = SCStreamConfiguration()
        configuration.width = Int(outputWidth)
        configuration.height = Int(outputHeight)
        configuration.showsCursor = false
        // Keep the same fixed BGRA surface as R8 instead of relying on a
        // framework default that may change with the OS.
        configuration.pixelFormat = kCVPixelFormatType_32BGRA

        guard gate.claimCapture() else { return }

        SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        ) { image, captureError in
            guard captureError == nil, let image else {
                finish(.captureFailed, selected: selected)
                return
            }
            guard image.width == Int(outputWidth), image.height == Int(outputHeight),
                  let rgba = renderRGBA(
                      image: image,
                      maxSide: maxSideInt,
                      maxBytes: maxBytes
                  ) else {
                finish(.imageInvalid, selected: selected)
                return
            }
            finish(
                .success,
                selected: selected,
                width: outputWidth,
                height: outputHeight,
                rgba: rgba
            )
        }
    }
    return 0
}
