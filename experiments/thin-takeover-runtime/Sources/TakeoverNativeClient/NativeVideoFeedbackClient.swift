import Foundation
import TakeoverCore

/// Native-client sender for decoder recovery feedback.
///
/// The only client->host feedback currently allowed is `requestIDR`. This message cannot grant
/// authority, approve an action, or resume the Agent. Requests are rate-limited locally before
/// they reach the wire; the host applies its own rate limit before forcing a keyframe.
public final class NativeVideoFeedbackClient: @unchecked Sendable {
    private let codec: SecureFeedbackCodec
    private let lock = NSLock()
    private let minIntervalNanos: UInt64
    private var sequence: UInt64 = 0
    private var lastRequestNanos: UInt64?

    public init(
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        minIntervalNanos: UInt64 = 150_000_000
    ) throws {
        precondition(minIntervalNanos > 0)
        self.codec = try SecureFeedbackCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .clientToHost,
            channel: .videoFeedback
        )
        self.minIntervalNanos = minIntervalNanos
    }

    /// Returns nil when a request would violate the local recovery rate limit.
    public func requestIDR(
        afterFrameID frameID: UInt64,
        nowNanos: UInt64 = MonotonicClock.nowNanos()
    ) throws -> Data? {
        lock.lock()
        if let lastRequestNanos, nowNanos &- lastRequestNanos < minIntervalNanos {
            lock.unlock()
            return nil
        }
        let current = sequence
        sequence &+= 1
        lastRequestNanos = nowNanos
        lock.unlock()
        return try codec.seal(FeedbackMessage(
            kind: .requestIDR,
            sequence: current,
            reference: frameID,
            monotonicNanos: nowNanos
        ))
    }
}
