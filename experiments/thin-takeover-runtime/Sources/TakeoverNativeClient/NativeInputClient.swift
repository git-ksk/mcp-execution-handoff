import Foundation
import TakeoverCore

public struct CriticalInputRetryPolicy: Sendable, Equatable {
    public let retryIntervalNanos: UInt64
    public let lifetimeNanos: UInt64
    public let maxAttempts: Int

    public init(
        retryIntervalNanos: UInt64 = 12_000_000,
        lifetimeNanos: UInt64 = 60_000_000,
        maxAttempts: Int = 4
    ) {
        precondition(retryIntervalNanos > 0)
        precondition(lifetimeNanos >= retryIntervalNanos)
        precondition(maxAttempts >= 1)
        self.retryIntervalNanos = retryIntervalNanos
        self.lifetimeNanos = lifetimeNanos
        self.maxAttempts = maxAttempts
    }
}

public struct NativeInputTransmission: Sendable, Equatable {
    public let event: InputEvent
    public let datagram: Data

    public init(event: InputEvent, datagram: Data) {
        self.event = event
        self.datagram = datagram
    }
}

/// Client-side authenticated input encoder with bounded critical retries.
///
/// Pointer movement and other realtime state are never retained for retransmission. Critical
/// events are retained only for the configured short deadline and are deduplicated by the host.
/// The embedding client must feed authenticated ACKs into `acknowledgeCritical` once the feedback
/// channel is active; expiry still bounds retry even when an ACK is lost.
public final class NativeInputClient: @unchecked Sendable {
    private struct PendingCritical {
        let transmission: NativeInputTransmission
        let expiresAtNanos: UInt64
        var nextRetryNanos: UInt64
        var attempts: Int
    }

    private let codec: SecureInputCodec
    private let retryPolicy: CriticalInputRetryPolicy
    private let lock = NSLock()
    private var realtimeSequence: UInt64 = 0
    private var criticalSequence: UInt64 = 0
    private var pending: [UInt64: PendingCritical] = [:]

    public init(
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        retryPolicy: CriticalInputRetryPolicy = CriticalInputRetryPolicy()
    ) throws {
        self.codec = try SecureInputCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.retryPolicy = retryPolicy
    }

    public func realtime(
        kind: InputEventKind,
        x: Int32 = 0,
        y: Int32 = 0,
        value: Int32 = 0,
        payload: Data = Data(),
        nowNanos: UInt64 = MonotonicClock.nowNanos()
    ) throws -> NativeInputTransmission {
        precondition(kind == .pointerMove || kind == .scroll)
        lock.lock()
        let sequence = realtimeSequence
        realtimeSequence &+= 1
        lock.unlock()
        let event = InputEvent(
            lane: .realtime,
            kind: kind,
            sequence: sequence,
            clientNanos: nowNanos,
            x: x,
            y: y,
            value: value,
            payload: payload
        )
        return NativeInputTransmission(event: event, datagram: try codec.seal(event))
    }

    public func critical(
        kind: InputEventKind,
        x: Int32 = 0,
        y: Int32 = 0,
        value: Int32 = 0,
        payload: Data = Data(),
        nowNanos: UInt64 = MonotonicClock.nowNanos()
    ) throws -> NativeInputTransmission {
        precondition(kind == .pointerButton || kind == .key || kind == .textCommit || kind == .scroll)
        lock.lock()
        let sequence = criticalSequence
        criticalSequence &+= 1
        lock.unlock()
        let event = InputEvent(
            lane: .critical,
            kind: kind,
            sequence: sequence,
            clientNanos: nowNanos,
            x: x,
            y: y,
            value: value,
            payload: payload
        )
        let transmission = NativeInputTransmission(event: event, datagram: try codec.seal(event))
        lock.lock()
        pending[sequence] = PendingCritical(
            transmission: transmission,
            expiresAtNanos: nowNanos &+ retryPolicy.lifetimeNanos,
            nextRetryNanos: nowNanos &+ retryPolicy.retryIntervalNanos,
            attempts: 1
        )
        lock.unlock()
        return transmission
    }

    public func acknowledgeCritical(sequence: UInt64) {
        lock.lock()
        pending.removeValue(forKey: sequence)
        lock.unlock()
    }

    /// Returns only retries that are due now. Stale events are removed instead of being delivered
    /// late, preserving interaction freshness over eventual delivery.
    public func dueCriticalRetries(nowNanos: UInt64 = MonotonicClock.nowNanos()) -> [NativeInputTransmission] {
        lock.lock()
        defer { lock.unlock() }
        var due: [NativeInputTransmission] = []
        var remove: [UInt64] = []
        for (sequence, var item) in pending {
            if nowNanos >= item.expiresAtNanos || item.attempts >= retryPolicy.maxAttempts {
                remove.append(sequence)
                continue
            }
            if nowNanos >= item.nextRetryNanos {
                due.append(item.transmission)
                item.attempts += 1
                item.nextRetryNanos = nowNanos &+ retryPolicy.retryIntervalNanos
                pending[sequence] = item
            }
        }
        for sequence in remove { pending.removeValue(forKey: sequence) }
        return due
    }

    public var pendingCriticalCount: Int {
        lock.lock(); defer { lock.unlock() }
        return pending.count
    }

    public func cancelPendingCritical() {
        lock.lock(); pending.removeAll(keepingCapacity: false); lock.unlock()
    }
}
