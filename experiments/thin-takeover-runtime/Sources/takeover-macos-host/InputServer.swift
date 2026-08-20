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
        var injectedCriticalOrder: [UInt64] = []
        var injectedCriticalSet = Set<UInt64>()
        defer { injector.releaseAll() }

        func rememberInjected(_ sequence: UInt64) {
            guard injectedCriticalSet.insert(sequence).inserted else { return }
            injectedCriticalOrder.append(sequence)
            if injectedCriticalOrder.count > 64 {
                let evicted = injectedCriticalOrder.removeFirst()
                injectedCriticalSet.remove(evicted)
            }
        }

        func sendAck(reference: UInt64) throws {
            let ack = FeedbackMessage(
                kind: .criticalInputAck,
                sequence: feedbackSequence,
                reference: reference,
                monotonicNanos: MonotonicClock.nowNanos()
            )
            feedbackSequence &+= 1
            try feedbackSender.send(feedbackCodec.seal(ack))
        }

        while lease.isActive() {
            do {
                guard let datagram = try receiver.receiveOrTimeout(maxBytes: 65_535) else {
                    continue
                }
                guard lease.isActive() else { break }
                let event = try codec.open(datagram)
                let acceptance = gate.accept(event)
                guard acceptance == .accepted else {
                    // A bounded retry of an event that was already injected is not injected twice,
                    // but it receives a fresh ACK so an earlier lost ACK does not keep the client
                    // retrying until its deadline. Unknown/too-old critical sequences stay silent.
                    if event.lane == .critical, injectedCriticalSet.contains(event.sequence) {
                        try sendAck(reference: event.sequence)
                    }
                    continue
                }
                guard lease.isActive() else { break }
                try injector.inject(event)

                // ACK only after the critical event passed authentication, replay gating and OS
                // injection. Remember only successfully injected sequences.
                if event.lane == .critical {
                    rememberInjected(event.sequence)
                    try sendAck(reference: event.sequence)
                }
            } catch {
                // Human-plane input is fail-closed and best-effort. Invalid, stale, unauthenticated,
                // or unsupported events are dropped without changing authority.
                continue
            }
        }
    }
}
#endif
