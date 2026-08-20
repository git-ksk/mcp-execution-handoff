import Foundation

/// Single-slot decoded-frame handoff between VideoToolbox callback threads and presentation.
///
/// Pushing a newer frame atomically replaces any frame not yet consumed by the renderer. This is
/// intentionally not a FIFO: display freshness has priority over presenting every decoded frame.
public final class LatestDecodedFrameStore: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: DecodedVideoFrame?

    public init() {}

    public func push(_ frame: DecodedVideoFrame) {
        lock.lock()
        latest = frame
        lock.unlock()
    }

    public func takeLatest() -> DecodedVideoFrame? {
        lock.lock()
        defer { lock.unlock() }
        let frame = latest
        latest = nil
        return frame
    }

    public func clear() {
        lock.lock()
        latest = nil
        lock.unlock()
    }
}
