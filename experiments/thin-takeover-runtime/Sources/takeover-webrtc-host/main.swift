import Foundation
import TakeoverCore

#if os(macOS)
import ApplicationServices
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

private enum WebRtcHostError: Error { case configuration, permission, display, encoder(OSStatus) }

private final class StopState: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
}

private func evenDimension(_ value: Double) -> Int {
    let rounded = max(2, Int(value.rounded(.down)))
    return rounded.isMultiple(of: 2) ? rounded : rounded - 1
}

private func selectedDisplay(from displays: [SCDisplay], requested: CGDirectDisplayID?) throws -> SCDisplay {
    guard !displays.isEmpty else { throw WebRtcHostError.display }
    if let requested {
        guard let display = displays.first(where: { $0.displayID == requested }) else { throw WebRtcHostError.display }
        return display
    }
    guard displays.count == 1, let display = displays.first else { throw WebRtcHostError.display }
    return display
}

private func loadDisplayID() throws -> CGDirectDisplayID? {
    guard let text = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_DISPLAY_ID"] else { return nil }
    guard let value = UInt32(text) else { throw WebRtcHostError.configuration }
    return CGDirectDisplayID(value)
}

private func makeLease() throws -> EphemeralSessionLease {
    guard let text = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS"], let expiry = UInt64(text) else {
        throw WebRtcHostError.configuration
    }
    let wallMillis = UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
    return try EphemeralLeaseFactory.make(expiresAtUnixMillis: expiry, nowUnixMillis: wallMillis, nowMonotonicNanos: MonotonicClock.nowNanos())
}

private final class LatestOutputWriter: @unchecked Sendable {
    private let handle = FileHandle.standardOutput
    private let queue = DispatchQueue(label: "takeover.webrtc.stdout", qos: .userInteractive)
    private let lock = NSLock()
    private var writing = false
    private var latestFrame: Data?
    private var latestControl: Data?

    func submitFrame(_ record: Data) { enqueue(record, control: false) }
    func submitEditable(_ editable: Bool) {
        let payload = Data([editable ? 1 : 0])
        var record = Data([2]); var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { record.append(contentsOf: $0) }
        record.append(payload); enqueue(record, control: true)
    }
    private func enqueue(_ record: Data, control: Bool) {
        lock.lock()
        if writing { if control { latestControl = record } else { latestFrame = record }; lock.unlock(); return }
        writing = true; lock.unlock()
        queue.async { [weak self] in self?.drain(first: record) }
    }
    private func drain(first: Data) {
        var current: Data? = first
        while let record = current {
            handle.write(record); lock.lock()
            if let control = latestControl { latestControl = nil; current = control }
            else if let frame = latestFrame { latestFrame = nil; current = frame }
            else { writing = false; current = nil }
            lock.unlock()
        }
    }
}

private final class H264PipeEncoder: @unchecked Sendable {
    typealias Completion = @Sendable () -> Void
    typealias Output = @Sendable (_ avcc: Data, _ timestamp: UInt32, _ keyframe: Bool) -> Void
    private var session: VTCompressionSession?
    private let output: Output
    private let keyframeLock = NSLock()
    private var forceNextKeyframe = false

    init(width: Int32, height: Int32, output: @escaping Output) throws {
        self.output = output
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault, width: width, height: height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
            ] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { refCon, sourceFrameRefCon, status, _, sampleBuffer in
                guard let sourceFrameRefCon else { return }
                let context = Unmanaged<FrameContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                defer { context.completion() }
                guard status == noErr, let refCon, let sampleBuffer else { return }
                Unmanaged<H264PipeEncoder>.fromOpaque(refCon).takeUnretainedValue().handle(sampleBuffer)
            }, refcon: refcon, compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw WebRtcHostError.encoder(status) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: 30))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        if #available(macOS 15.0, *) { VTSessionSetProperty(session, key: kVTCompressionPropertyKey_SuggestedLookAheadFrameCount, value: NSNumber(value: 0)) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: 3_000_000))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: 30))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(session) }
    }

    func requestIDR() {
        keyframeLock.lock(); forceNextKeyframe = true; keyframeLock.unlock()
    }

    private func consumeKeyframeRequest() -> Bool {
        keyframeLock.lock(); defer { keyframeLock.unlock() }
        let value = forceNextKeyframe; forceNextKeyframe = false; return value
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, completion: @escaping Completion) {
        guard let session else { completion(); return }
        let context = Unmanaged.passRetained(FrameContext(completion: completion)).toOpaque()
        var flags: VTEncodeInfoFlags = []
        let frameProperties: CFDictionary? = consumeKeyframeRequest()
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
            : nil
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid, frameProperties: frameProperties, sourceFrameRefcon: context, infoFlagsOut: &flags)
        if status != noErr { Unmanaged<FrameContext>.fromOpaque(context).release(); completion() }
    }

    private final class FrameContext {
        let completion: Completion
        init(completion: @escaping Completion) { self.completion = completion }
    }

    private func handle(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer), let block = CMSampleBufferGetDataBuffer(sampleBuffer), let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        var nalHeaderLength = 4
        var parameterSets: [Data] = []
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        var count = 0
        var headerLength: Int32 = 0
        let parameterStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &headerLength
        )
        if parameterStatus == noErr, headerLength > 0 { nalHeaderLength = Int(headerLength) }
        if keyframe, parameterStatus == noErr, let pointer, size > 0 {
            parameterSets.append(Data(bytes: pointer, count: size))
            if count > 1 {
                var ppsPointer: UnsafePointer<UInt8>?; var ppsSize = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: 1, parameterSetPointerOut: &ppsPointer, parameterSetSizeOut: &ppsSize,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
                ) == noErr, let ppsPointer, ppsSize > 0 { parameterSets.append(Data(bytes: ppsPointer, count: ppsSize)) }
            }
        }
        let totalLength = CMBlockBufferGetDataLength(block)
        guard totalLength > 0 else { return }
        var sample = Data(count: totalLength)
        let copyStatus = sample.withUnsafeMutableBytes { bytes -> OSStatus in
            guard let base = bytes.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: totalLength, destination: base)
        }
        guard copyStatus == noErr, let normalized = normalizeAvcc(sample, nalHeaderLength: nalHeaderLength, prefix: parameterSets) else { return }
        sample.resetBytes(in: 0..<sample.count)
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let scaled = CMTimeConvertScale(pts, timescale: 90_000, method: .default)
        output(normalized, UInt32(truncatingIfNeeded: max(Int64(0), scaled.value)), keyframe)
    }

    private func normalizeAvcc(_ sample: Data, nalHeaderLength: Int, prefix: [Data]) -> Data? {
        guard (1...4).contains(nalHeaderLength) else { return nil }
        var result = Data(); result.reserveCapacity(sample.count + prefix.reduce(0) { $0 + $1.count + 4 })
        func appendNAL(_ nal: Data) {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { result.append(contentsOf: $0) }; result.append(nal)
        }
        for nal in prefix { appendNAL(nal) }
        var offset = 0
        while offset < sample.count {
            guard offset + nalHeaderLength <= sample.count else { return nil }
            var length = 0
            for byte in sample[offset..<(offset + nalHeaderLength)] { length = (length << 8) | Int(byte) }
            offset += nalHeaderLength
            guard length > 0, offset + length <= sample.count else { return nil }
            appendNAL(sample.subdata(in: offset..<(offset + length))); offset += length
        }
        return result.isEmpty ? nil : result
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let encoder: H264PipeEncoder
    private let admission = FrameAdmissionGate(maxInFlight: 1)
    private let lease: EphemeralSessionLease
    init(encoder: H264PipeEncoder, lease: EphemeralSessionLease) { self.encoder = encoder; self.lease = lease }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard lease.isActive(), type == .screen, let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if let array = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let info = array.first, let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        guard admission.tryAcquire() else { return }
        encoder.encode(pixel, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) { [admission] in admission.release() }
    }
}

private final class HumanInputInjector: @unchecked Sendable {
    private let source = CGEventSource(stateID: .hidSystemState)
    private let displayID: CGDirectDisplayID
    private let writer: LatestOutputWriter
    init(displayID: CGDirectDisplayID, writer: LatestOutputWriter) { self.displayID = displayID; self.writer = writer }

    func apply(_ object: [String: Any]) {
        guard let kind = object["kind"] as? String else { return }
        switch kind {
        case "tap":
            guard let x = number(object["x"]), let y = number(object["y"]), (0...1).contains(x), (0...1).contains(y) else { return }
            let point = screenPoint(x: x, y: y)
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { return }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            usleep(20_000)
            writer.submitEditable(focusedElementIsEditable())
        case "scroll":
            guard let dx = number(object["deltaX"]), let dy = number(object["deltaY"]), abs(dx) <= 2_000, abs(dy) <= 2_000 else { return }
            guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0) else { return }
            event.post(tap: .cghidEventTap)
        case "text":
            guard let text = object["text"] as? String, !text.isEmpty, text.utf8.count <= 4_096 else { return }
            let utf16 = Array(text.utf16)
            guard utf16.count <= 1_024,
                  let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return }
            utf16.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        case "key":
            guard let key = object["key"] as? String else { return }
            let code: CGKeyCode
            switch key { case "Backspace": code = 51; case "Enter": code = 36; default: return }
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        default: return
        }
    }

    private func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
    private func screenPoint(x: Double, y: Double) -> CGPoint {
        let bounds = CGDisplayBounds(displayID)
        return CGPoint(x: bounds.minX + bounds.width * x, y: bounds.minY + bounds.height * y)
    }
    private func focusedElementIsEditable() -> Bool {
        let system = AXUIElementCreateSystemWide(); var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &raw) == .success, let raw else { return false }
        let element = unsafeDowncast(raw, to: AXUIElement.self); var roleRaw: CFTypeRef?
        let role = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRaw) == .success ? roleRaw as? String : nil
        if role == (kAXTextFieldRole as String) || role == (kAXTextAreaRole as String) || role == (kAXComboBoxRole as String) { return true }
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
    }
}

private final class InputReader: @unchecked Sendable {
    private let stop: StopState
    private let injector: HumanInputInjector
    private let requestIDR: @Sendable () -> Void
    init(stop: StopState, injector: HumanInputInjector, requestIDR: @escaping @Sendable () -> Void) {
        self.stop = stop; self.injector = injector; self.requestIDR = requestIDR
    }
    func start() {
        Thread.detachNewThread { [stop, injector, requestIDR] in
            let handle = FileHandle.standardInput; var pending = Data()
            while !stop.isStopped {
                let chunk: Data
                do { chunk = try handle.read(upToCount: 2_048) ?? Data() } catch { stop.stop(); break }
                guard !chunk.isEmpty else { stop.stop(); break }
                pending.append(chunk)
                if pending.count > 8_192 { stop.stop(); break }
                while let newline = pending.firstIndex(of: 0x0A) {
                    let line = pending.prefix(upTo: newline); pending.removeSubrange(...newline)
                    guard !line.isEmpty, line.count <= 4_096,
                          let value = try? JSONSerialization.jsonObject(with: Data(line)),
                          let object = value as? [String: Any], let kind = object["kind"] as? String else { continue }
                    if kind == "stop" { stop.stop(); return }
                    if kind == "requestIDR" { requestIDR(); continue }
                    injector.apply(object)
                }
            }
        }
    }
}

private func frameRecord(avcc: Data, timestamp: UInt32, keyframe: Bool, width: Int, height: Int) -> Data? {
    guard width > 0, width <= Int(UInt16.max), height > 0, height <= Int(UInt16.max), avcc.count <= 8 * 1024 * 1024 - 9 else { return nil }
    var payload = Data(); payload.reserveCapacity(9 + avcc.count)
    var timestampBE = timestamp.bigEndian; withUnsafeBytes(of: &timestampBE) { payload.append(contentsOf: $0) }
    payload.append(keyframe ? 1 : 0)
    var widthBE = UInt16(width).bigEndian; var heightBE = UInt16(height).bigEndian
    withUnsafeBytes(of: &widthBE) { payload.append(contentsOf: $0) }; withUnsafeBytes(of: &heightBE) { payload.append(contentsOf: $0) }
    payload.append(avcc)
    var record = Data([1]); var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { record.append(contentsOf: $0) }; record.append(payload); return record
}

@main
struct WebRtcMacHost {
    static func main() async throws {
        guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else { throw WebRtcHostError.permission }
        let lease = try makeLease(); let stop = StopState()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let display = try selectedDisplay(from: content.displays, requested: loadDisplayID())
        let nativeWidth = Double(display.width), nativeHeight = Double(display.height)
        guard nativeWidth > 0, nativeHeight > 0 else { throw WebRtcHostError.display }
        let scale = min(1.0, min(1280.0 / nativeWidth, 720.0 / nativeHeight))
        let width = evenDimension(nativeWidth * scale), height = evenDimension(nativeHeight * scale)

        let writer = LatestOutputWriter()
        let encoder = try H264PipeEncoder(width: Int32(width), height: Int32(height)) { avcc, timestamp, keyframe in
            if lease.isActive(), !stop.isStopped,
               let record = frameRecord(avcc: avcc, timestamp: timestamp, keyframe: keyframe, width: width, height: height) {
                writer.submitFrame(record)
            }
        }
        let injector = HumanInputInjector(displayID: display.displayID, writer: writer)
        InputReader(stop: stop, injector: injector, requestIDR: { encoder.requestIDR() }).start()

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = width; configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 2
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.capturesAudio = false; configuration.showsCursor = false

        let output = CaptureOutput(encoder: encoder, lease: lease)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "takeover.webrtc.capture", qos: .userInteractive))
        try await stream.startCapture()
        while lease.isActive(), !stop.isStopped { try await Task.sleep(for: .milliseconds(40)) }
        lease.revoke(); try? await stream.stopCapture()
    }
}
#else
@main
struct WebRtcMacHost { static func main() {} }
#endif
