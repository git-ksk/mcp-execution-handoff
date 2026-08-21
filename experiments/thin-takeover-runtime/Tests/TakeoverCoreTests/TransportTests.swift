import Foundation
import Testing
@testable import TakeoverCore

@Test func transportCipherRoundTripsAndBindsContext() throws {
    let cipher = try TransportCipher(rootKey: Data(repeating: 0x42, count: 32))
    let context = TransportCryptoContext(
        sessionHash: 11,
        epoch: 7,
        generation: 3,
        direction: .hostToClient,
        channel: .video
    )
    let plaintext = Data("frame".utf8)
    let aad = Data([VideoPacketFlags.keyframe])
    let sealed = try cipher.seal(plaintext, sequence: 9, context: context, associatedData: aad)
    let sealedAgain = try cipher.seal(plaintext, sequence: 9, context: context, associatedData: aad)
    #expect(sealed != sealedAgain)
    #expect(try cipher.open(sealed, sequence: 9, context: context, associatedData: aad) == plaintext)
    #expect(try cipher.open(sealedAgain, sequence: 9, context: context, associatedData: aad) == plaintext)

    let wrongEpoch = TransportCryptoContext(
        sessionHash: 11,
        epoch: 8,
        generation: 3,
        direction: .hostToClient,
        channel: .video
    )
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try cipher.open(sealed, sequence: 9, context: wrongEpoch, associatedData: aad)
    }
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try cipher.open(sealed, sequence: 10, context: context, associatedData: aad)
    }
}

@Test func transportCipherRejectsTamperingAndDirectionReplay() throws {
    let cipher = try TransportCipher(rootKey: Data(repeating: 0x11, count: 32))
    let outbound = TransportCryptoContext(
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        direction: .hostToClient,
        channel: .video
    )
    var sealed = try cipher.seal(Data(repeating: 0xAB, count: 128), sequence: 4, context: outbound)
    sealed[sealed.startIndex] ^= 0x01
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try cipher.open(sealed, sequence: 4, context: outbound)
    }

    let valid = try cipher.seal(Data("x".utf8), sequence: 5, context: outbound)
    let inbound = TransportCryptoContext(
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        direction: .clientToHost,
        channel: .video
    )
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try cipher.open(valid, sequence: 5, context: inbound)
    }
}

@Test func inputWireRoundTripsAndLatestWins() throws {
    let event = InputEvent(
        lane: .realtime,
        kind: .pointerMove,
        sequence: 12,
        clientNanos: 99,
        x: 123,
        y: -45,
        value: 0
    )
    #expect(try InputEvent.decode(event.encode()) == event)

    var gate = InputSequenceGate()
    #expect(gate.accept(event) == .accepted)
    #expect(gate.accept(event) == .duplicateOrStale)
    let newer = InputEvent(lane: .realtime, kind: .pointerMove, sequence: 13, clientNanos: 100)
    #expect(gate.accept(newer) == .accepted)
    let older = InputEvent(lane: .realtime, kind: .pointerMove, sequence: 11, clientNanos: 98)
    #expect(gate.accept(older) == .duplicateOrStale)
}

@Test func criticalInputDeduplicatesBoundedRetries() {
    var gate = InputSequenceGate()
    let click = InputEvent(lane: .critical, kind: .pointerButton, sequence: 100, clientNanos: 1, value: 1)
    #expect(gate.accept(click) == .accepted)
    #expect(gate.accept(click) == .duplicateOrStale)
    let next = InputEvent(lane: .critical, kind: .pointerButton, sequence: 101, clientNanos: 2, value: 0)
    #expect(gate.accept(next) == .accepted)
    #expect(gate.accept(InputEvent(lane: .realtime, kind: .key, sequence: 102, clientNanos: 3)) == .laneKindMismatch)
}

@Test func recoveryIsDeadlineBoundedAndRateLimited() {
    var planner = RecoveryPlanner(policy: RecoveryPolicy(maxKeyframeNackPackets: 2, minIDRIntervalNanos: 100))
    #expect(planner.planIncompleteFrame(
        frameID: 1,
        isKeyframe: false,
        missingPacketIndexes: [2],
        nowNanos: 10,
        frameDeadlineNanos: 20
    ) == .dropFrame)

    #expect(planner.planIncompleteFrame(
        frameID: 2,
        isKeyframe: true,
        missingPacketIndexes: [1, 3],
        nowNanos: 10,
        frameDeadlineNanos: 20
    ) == .nack(frameID: 2, missing: [1, 3], expiresAtNanos: 20))

    #expect(planner.planIncompleteFrame(
        frameID: 2,
        isKeyframe: true,
        missingPacketIndexes: [1, 3],
        nowNanos: 21,
        frameDeadlineNanos: 20
    ) == .requestIDR)
    #expect(planner.decoderLostSync(nowNanos: 50) == .dropFrame)
    #expect(planner.decoderLostSync(nowNanos: 121) == .requestIDR)
}
