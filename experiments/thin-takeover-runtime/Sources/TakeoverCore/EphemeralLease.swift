import Foundation

/// Process-local fail-closed lease for one Human Takeover transport generation.
///
/// The authority/control plane still owns the actual capability lifecycle. This object gives
/// transport adapters a monotonic deadline and an immediate revoke switch so media/input cannot
/// continue indefinitely if a host process outlives its short-lived grant.
public final class EphemeralSessionLease: @unchecked Sendable {
    private let lock = NSLock()
    public let deadlineNanos: UInt64
    private var revoked = false

    public init(deadlineNanos: UInt64) {
        self.deadlineNanos = deadlineNanos
    }

    @inline(__always)
    public func isActive(nowNanos: UInt64 = MonotonicClock.nowNanos()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !revoked && nowNanos < deadlineNanos
    }

    public func revoke() {
        lock.lock()
        revoked = true
        lock.unlock()
    }
}

public enum EphemeralLeaseError: Error, Equatable {
    case alreadyExpired
    case durationOverflow
}

public enum EphemeralLeaseFactory {
    /// Convert a control-plane wall-clock expiry into one local monotonic deadline at startup.
    /// The hot path can then avoid wall-clock jumps.
    public static func make(
        expiresAtUnixMillis: UInt64,
        nowUnixMillis: UInt64,
        nowMonotonicNanos: UInt64
    ) throws -> EphemeralSessionLease {
        guard expiresAtUnixMillis > nowUnixMillis else {
            throw EphemeralLeaseError.alreadyExpired
        }
        let remainingMillis = expiresAtUnixMillis - nowUnixMillis
        let (durationNanos, multiplyOverflow) = remainingMillis.multipliedReportingOverflow(by: 1_000_000)
        guard !multiplyOverflow else { throw EphemeralLeaseError.durationOverflow }
        let (deadline, addOverflow) = nowMonotonicNanos.addingReportingOverflow(durationNanos)
        guard !addOverflow else { throw EphemeralLeaseError.durationOverflow }
        return EphemeralSessionLease(deadlineNanos: deadline)
    }
}
