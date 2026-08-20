import Foundation
import Testing
@testable import TakeoverCore

@Test func inputAckFeedbackRoundTripsAndIsDirectionBound() throws {
    let key = Data(repeating: 0x61, count: 32)
    let hostCodec = try SecureFeedbackCodec(
        rootKey: key,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        direction: .hostToClient,
        channel: .inputFeedback
    )
    let message = FeedbackMessage(
        kind: .criticalInputAck,
        sequence: 4,
        reference: 99,
        monotonicNanos: 123
    )
    let datagram = try hostCodec.seal(message)
    #expect(try hostCodec.open(datagram) == message)

    let idrCodec = try SecureFeedbackCodec(
        rootKey: key,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        direction: .clientToHost,
        channel: .videoFeedback
    )
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try idrCodec.open(datagram)
    }
}

@Test func idrFeedbackRoundTripsAndWrongKindFailsClosed() throws {
    let key = Data(repeating: 0x62, count: 32)
    let codec = try SecureFeedbackCodec(
        rootKey: key,
        sessionHash: 7,
        epoch: 8,
        generation: 9,
        direction: .clientToHost,
        channel: .videoFeedback
    )
    let request = FeedbackMessage(kind: .requestIDR, sequence: 1, reference: 42, monotonicNanos: 500)
    #expect(try codec.open(codec.seal(request)) == request)

    let forbidden = FeedbackMessage(kind: .criticalInputAck, sequence: 2, reference: 42, monotonicNanos: 501)
    #expect(throws: FeedbackProtocolError.directionMismatch) {
        _ = try codec.seal(forbidden)
    }
}

@Test func feedbackSequenceGateRejectsReplay() {
    var gate = FeedbackSequenceGate()
    let first = gate.accept(10)
    let replay = gate.accept(10)
    let older = gate.accept(9)
    let next = gate.accept(11)
    #expect(first)
    #expect(!replay)
    #expect(!older)
    #expect(next)
}
