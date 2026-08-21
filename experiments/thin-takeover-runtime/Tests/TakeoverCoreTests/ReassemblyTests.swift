import Foundation
import Testing
@testable import TakeoverCore

@Test func secureInputRoundTripsAndRejectsTamper() throws {
    let key = Data(repeating: 0x33, count: 32)
    let codec = try SecureInputCodec(rootKey: key, sessionHash: 9, epoch: 4, generation: 2)
    let event = InputEvent(
        lane: .critical,
        kind: .key,
        sequence: 77,
        clientNanos: 123,
        value: 1,
        payload: Data("a".utf8)
    )
    let datagram = try codec.seal(event)
    #expect(try codec.open(datagram) == event)

    var tampered = datagram
    tampered[tampered.index(before: tampered.endIndex)] ^= 0x01
    #expect(throws: TransportCryptoError.authenticationFailed) {
        _ = try codec.open(tampered)
    }
}

@Test func reassemblerCompletesOutOfOrderFrame() throws {
    let key = Data(repeating: 0x10, count: 32)
    let authenticator = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 10, epoch: 20, generation: 3)
    let payload = Data((0..<10_000).map { UInt8(truncatingIfNeeded: $0) })
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let packets = packetizer.packetize(
        payload: payload,
        sessionHash: 10,
        epoch: 20,
        generation: 3,
        frameID: 5,
        captureNanos: 1,
        encodeDoneNanos: 2,
        keyframe: true,
        authenticator: authenticator
    )
    var reassembler = FrameReassembler(
        sessionHash: 10,
        epoch: 20,
        generation: 3,
        headerAuthenticator: authenticator
    )
    var completed: ReassembledFrame?
    for packet in packets.reversed() {
        if case .complete(let frame) = reassembler.ingest(packet) {
            completed = frame
        }
    }
    #expect(completed?.sealedPayload == payload)
    #expect(completed?.header.frameID == 5)
}

@Test func reassemblerDropsOlderFrameAfterNewerStarts() throws {
    let key = Data(repeating: 0x11, count: 32)
    let authenticator = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 1, epoch: 1, generation: 1)
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let oldPackets = packetizer.packetize(
        payload: Data(repeating: 1, count: 4_000),
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 10,
        captureNanos: 1,
        encodeDoneNanos: 2,
        keyframe: false,
        authenticator: authenticator
    )
    let newPackets = packetizer.packetize(
        payload: Data(repeating: 2, count: 4_000),
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 11,
        captureNanos: 3,
        encodeDoneNanos: 4,
        keyframe: false,
        authenticator: authenticator
    )
    var reassembler = FrameReassembler(
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        headerAuthenticator: authenticator
    )
    #expect(reassembler.ingest(oldPackets[0]) == .incomplete)
    #expect(reassembler.ingest(newPackets[0]) == .incomplete)
    #expect(reassembler.ingest(oldPackets[1]) == .droppedStale)
}

@Test func reassemblerRejectsWrongBindingAndOversize() throws {
    let key = Data(repeating: 0x12, count: 32)
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let packetAuth = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 99, epoch: 1, generation: 1)
    let packet = packetizer.packetize(
        payload: Data(repeating: 7, count: 2_000),
        sessionHash: 99,
        epoch: 1,
        generation: 1,
        frameID: 1,
        captureNanos: 1,
        encodeDoneNanos: 1,
        keyframe: false,
        authenticator: packetAuth
    )[0]
    let wrongAuth = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 100, epoch: 1, generation: 1)
    var wrongBinding = FrameReassembler(
        sessionHash: 100,
        epoch: 1,
        generation: 1,
        headerAuthenticator: wrongAuth
    )
    #expect(wrongBinding.ingest(packet) == .droppedInvalid)

    let tinyAuth = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 1, epoch: 1, generation: 1)
    let packets = packetizer.packetize(
        payload: Data(repeating: 8, count: 2_000),
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 2,
        captureNanos: 1,
        encodeDoneNanos: 1,
        keyframe: false,
        authenticator: tinyAuth
    )
    var tiny = FrameReassembler(
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        headerAuthenticator: tinyAuth,
        maxFrameBytes: 1000
    )
    var result: FrameReassemblyResult = .incomplete
    for item in packets {
        result = tiny.ingest(item)
        if result == .droppedOversize { break }
    }
    #expect(result == .droppedOversize)
}

@Test func reassemblerRejectsForgedHeaderAndCompletedReplay() throws {
    let key = Data(repeating: 0x13, count: 32)
    let authenticator = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 7, epoch: 8, generation: 9)
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let packets = packetizer.packetize(
        payload: Data(repeating: 0xA5, count: 4_000),
        sessionHash: 7,
        epoch: 8,
        generation: 9,
        frameID: 12,
        captureNanos: 100,
        encodeDoneNanos: 200,
        keyframe: false,
        authenticator: authenticator
    )

    var forged = packets[0]
    let frameIDByteOffset = 28
    forged[frameIDByteOffset] ^= 0x01

    var reassembler = FrameReassembler(
        sessionHash: 7,
        epoch: 8,
        generation: 9,
        headerAuthenticator: authenticator
    )
    #expect(reassembler.ingest(forged) == .droppedInvalid)

    var completed = false
    for packet in packets {
        if case .complete = reassembler.ingest(packet) { completed = true }
    }
    #expect(completed)
    #expect(reassembler.ingest(packets[0]) == .droppedStale)
}
