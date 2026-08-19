import Foundation
import Testing
@testable import TakeoverCore

@Test func secureControlRoundTripsAndRejectsTamper() throws {
    let key = Data(repeating: 0x44, count: 32)
    let codec = try SecureControlCodec(rootKey: key, sessionHash: 5, epoch: 6, generation: 7)
    let message = ControlMessage(kind: .revoke, sequence: 99)
    let datagram = try codec.seal(message)
    #expect(try codec.open(datagram) == message)

    var tampered = datagram
    tampered[tampered.index(before: tampered.endIndex)] ^= 0x01
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try codec.open(tampered)
    }
}

@Test func controlSequenceGateRejectsReplay() {
    var gate = ControlSequenceGate()
    let first = gate.accept(100)
    let duplicate = gate.accept(100)
    let older = gate.accept(99)
    let newer = gate.accept(101)
    #expect(first)
    #expect(!duplicate)
    #expect(!older)
    #expect(newer)
}

@Test func videoHeaderAuthenticatorRejectsRoutingMutation() throws {
    let authenticator = try VideoHeaderAuthenticator(
        rootKey: Data(repeating: 0x45, count: 32),
        sessionHash: 1,
        epoch: 2,
        generation: 3
    )
    let header = VideoPacketHeader(
        flags: VideoPacketFlags.keyframe,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        frameID: 4,
        packetIndex: 5,
        packetCount: 6,
        captureNanos: 7,
        encodeDoneNanos: 8
    )
    let authenticated = authenticator.authenticate(header)
    #expect(authenticator.verify(authenticated))

    var forged = authenticated
    forged.packetCount = 7
    #expect(!authenticator.verify(forged))
}
