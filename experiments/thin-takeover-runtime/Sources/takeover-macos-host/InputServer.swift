import Foundation
import TakeoverCore

#if os(macOS)
import CoreGraphics

final class SecureInputServer: @unchecked Sendable {
    private let receiver: DatagramReceiver
    private let codec: SecureInputCodec
    private let lease: EphemeralSessionLease
    private let injector: MacOSInputInjector
    private let feedbackSender: DatagramSender
    private let feedbackCodec: SecureFeedbackCodec

    init(
        bindHost: String,
        port: UInt16,
        feedbackHost: String,
        feedbackPort: UInt16,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        displayID: CGDirectDisplayID,
        lease: EphemeralSessionLease
    ) throws {
        self.receiver = try DatagramReceiver(
            host: bindHost,
            port: port,
            receiveTimeoutMillis: 50,
            receiveBufferBytes: 131_072
        )
        self.codec = try SecureInputCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.feedbackSender = try DatagramSender(host: feedbackHost, port: feedbackPort)
        self.feedbackCodec = try SecureFeedbackCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .hostToClient,
            channel: .inputFeedback
        )
        self.lease = lease
        self.injector = MacOSInputInjector(displayID: displayID)
    }

    func run() {
        var gate = InputSequenceGate()
        var feedbackSequence: UInt64 = 0
        defer { injector.releaseAll() }

        while lease.isActive() {
            do {
                guard let datagram = try receiver.receiveOrTimeout(maxBytes: 65_535) else {
                    continue
                }
                guard lease.isActive() else { break }
                let event = try codec.open(datagram)
                guard gate.accept(event) == .accepted else { continue }
                guard lease.isActive() else { break }
                try injector.inject(event)

                // ACK only after the critical event passed authentication, replay gating and OS
                // injection. If the ACK is lost, a retry is safe because the input gate dedupes it.
                if event.lane == .critical {
                    let ack = FeedbackMessage(
                        kind: .criticalInputAck,
                        sequence: feedbackSequence,
                        reference: event.sequence,
                        monotonicNanos: MonotonicClock.nowNanos()
                    )
                    feedbackSequence &+= 1
                    let sealed = try feedbackCodec.seal(ack)
                    try feedbackSender.send(sealed)
                }
            } catch {
                // Human-plane input is fail-closed and best-effort. Invalid, stale, unauthenticated,
                // or unsupported events are dropped without changing authority. A lost ACK never
                // causes double injection because retries hit the receiver dedupe gate.
                continue
            }
        }
    }
}
#endif
