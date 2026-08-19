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
        value: 13,
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
        keyframe: true
    )
    var reassembler = FrameReassembler(sessionHash: 10, epoch: 20, generation: 3)
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
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let oldPackets = packetizer.packetize(
        payload: Data(repeating: 1, count: 4_000),
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 10,
        captureNanos: 1,
        encodeDoneNanos: 2,
        keyframe: false
    )
    let newPackets = packetizer.packetize(
        payload: Data(repeating: 2, count: 4_000),
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 11,
        captureNanos: 3,
        encodeDoneNanos: 4,
        keyframe: false
    )
    var reassembler = FrameReassembler(sessionHash: 1, epoch: 1, generation: 1)
    #expect(reassembler.ingest(oldPackets[0]) == .incomplete)
    #expect(reassembler.ingest(newPackets[0]) == .incomplete)
    #expect(reassembler.ingest(oldPackets[1]) == .droppedStale)
}

@Test func reassemblerRejectsWrongBindingAndOversize() throws {
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let packet = packetizer.packetize(
        payload: Data(repeating: 7, count: 2_000),
        sessionHash: 99,
        epoch: 1,
        generation: 1,
        frameID: 1,
        captureNanos: 1,
        encodeDoneNanos: 1,
        keyframe: false
    )[0]
    var wrongBinding = FrameReassembler(sessionHash: 100, epoch: 1, generation: 1)
    #expect(wrongBinding.ingest(packet) == .droppedInvalid)

    let packets = packetizer.packetize(
        payload: Data(repeating: 8, count: 2_000),
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 2,
        captureNanos: 1,
        encodeDoneNanos: 1,
        keyframe: false
    )
    var tiny = FrameReassembler(sessionHash: 1, epoch: 1, generation: 1, maxFrameBytes: 1000)
    var result: FrameReassemblyResult = .incomplete
    for item in packets {
        result = tiny.ingest(item)
        if result == .droppedOversize { break }
    }
    #expect(result == .droppedOversize)
}
