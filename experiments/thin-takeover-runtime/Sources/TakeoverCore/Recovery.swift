import Foundation

public enum RecoveryDecision: Sendable, Equatable {
    case none
    case dropFrame
    case nack(frameID: UInt64, missing: [UInt16], expiresAtNanos: UInt64)
    case requestIDR
}

public struct RecoveryPolicy: Sendable, Equatable {
    public var maxKeyframeNackPackets: Int
    public var minIDRIntervalNanos: UInt64

    public init(
        maxKeyframeNackPackets: Int = 4,
        minIDRIntervalNanos: UInt64 = 100_000_000
    ) {
        precondition(maxKeyframeNackPackets >= 0)
        self.maxKeyframeNackPackets = maxKeyframeNackPackets
        self.minIDRIntervalNanos = minIDRIntervalNanos
    }
}

/// Keeps ordinary video newest-frame-wins while giving decoder-critical keyframes a tiny,
/// deadline-bounded repair window. It never requests unbounded retransmission.
public struct RecoveryPlanner: Sendable {
    public let policy: RecoveryPolicy
    private var lastIDRRequestNanos: UInt64?

    public init(policy: RecoveryPolicy = RecoveryPolicy()) {
        self.policy = policy
    }

    public mutating func planIncompleteFrame(
        frameID: UInt64,
        isKeyframe: Bool,
        missingPacketIndexes: [UInt16],
        nowNanos: UInt64,
        frameDeadlineNanos: UInt64
    ) -> RecoveryDecision {
        guard !missingPacketIndexes.isEmpty else { return .none }
        guard isKeyframe else { return .dropFrame }

        if nowNanos < frameDeadlineNanos,
           missingPacketIndexes.count <= policy.maxKeyframeNackPackets {
            return .nack(
                frameID: frameID,
                missing: missingPacketIndexes,
                expiresAtNanos: frameDeadlineNanos
            )
        }

        return maybeRequestIDR(nowNanos: nowNanos)
    }

    public mutating func decoderLostSync(nowNanos: UInt64) -> RecoveryDecision {
        maybeRequestIDR(nowNanos: nowNanos)
    }

    private mutating func maybeRequestIDR(nowNanos: UInt64) -> RecoveryDecision {
        if let lastIDRRequestNanos,
           nowNanos >= lastIDRRequestNanos,
           nowNanos - lastIDRRequestNanos < policy.minIDRIntervalNanos {
            return .dropFrame
        }
        lastIDRRequestNanos = nowNanos
        return .requestIDR
    }
}
