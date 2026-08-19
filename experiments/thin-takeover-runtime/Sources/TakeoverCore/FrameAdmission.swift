import Foundation

public struct FrameAdmissionSnapshot: Sendable, Equatable {
    public let accepted: UInt64
    public let droppedBusy: UInt64
    public let inFlight: Int
}

/// Bounds encoder work so stale capture frames never build an unbounded latency queue.
/// A maxInFlight of 1 is the aggressive ultra-low-latency mode: if the encoder is still
/// processing the prior frame, the new capture frame is dropped rather than queued.
public final class FrameAdmissionGate: @unchecked Sendable {
    private let lock = NSLock()
    private let maxInFlight: Int
    private var inFlight = 0
    private var accepted: UInt64 = 0
    private var droppedBusy: UInt64 = 0

    public init(maxInFlight: Int = 1) {
        precondition(maxInFlight > 0)
        self.maxInFlight = maxInFlight
    }

    public func tryAcquire() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard inFlight < maxInFlight else {
            droppedBusy &+= 1
            return false
        }
        inFlight += 1
        accepted &+= 1
        return true
    }

    public func release() {
        lock.lock()
        defer { lock.unlock() }
        precondition(inFlight > 0, "release without matching acquire")
        inFlight -= 1
    }

    public func snapshot() -> FrameAdmissionSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return FrameAdmissionSnapshot(accepted: accepted, droppedBusy: droppedBusy, inFlight: inFlight)
    }
}
