import Foundation
import Testing
@testable import TakeoverCore

@Test func packetHeaderRoundTrips() throws {
    let header = VideoPacketHeader(
        flags: 1,
        sessionHash: 42,
        epoch: 7,
        generation: 3,
        frameID: 99,
        packetIndex: 2,
        packetCount: 8,
        captureNanos: 1234,
        encodeDoneNanos: 2345
    )
    #expect(try VideoPacketHeader.decode(header.encode()) == header)
}

@Test func packetizerHonorsMtu() throws {
    let payload = Data(repeating: 0xAB, count: 50_000)
    let packets = VideoPacketizer(maxDatagramBytes: 1200).packetize(
        payload: payload,
        sessionHash: 1,
        epoch: 1,
        generation: 1,
        frameID: 1,
        captureNanos: 1,
        encodeDoneNanos: 2,
        keyframe: false
    )
    #expect(!packets.isEmpty)
    #expect(packets.allSatisfy { $0.count <= 1200 })
    let first = try VideoPacketHeader.decode(packets[0])
    #expect(first.packetCount == UInt16(packets.count))
}

@Test func packetSlicesCoverPayloadWithoutOverlap() throws {
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    let payloadBytes = 32_000
    var slices: [VideoPacketSlice] = []
    packetizer.forEachPacket(
        payloadBytes: payloadBytes,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        frameID: 4,
        captureNanos: 5,
        encodeDoneNanos: 6,
        keyframe: true
    ) { slices.append($0) }

    #expect(slices.first?.payloadRange.lowerBound == 0)
    #expect(slices.last?.payloadRange.upperBound == payloadBytes)
    for pair in zip(slices, slices.dropFirst()) {
        #expect(pair.0.payloadRange.upperBound == pair.1.payloadRange.lowerBound)
    }
    #expect(slices.allSatisfy { $0.payloadRange.count + VideoPacketHeader.encodedSize <= 1200 })
}

@Test func frameAdmissionDropsInsteadOfQueueing() {
    let gate = FrameAdmissionGate(maxInFlight: 1)
    #expect(gate.tryAcquire())
    #expect(!gate.tryAcquire())
    var snapshot = gate.snapshot()
    #expect(snapshot.accepted == 1)
    #expect(snapshot.droppedBusy == 1)
    #expect(snapshot.inFlight == 1)

    gate.release()
    #expect(gate.tryAcquire())
    gate.release()
    snapshot = gate.snapshot()
    #expect(snapshot.accepted == 2)
    #expect(snapshot.droppedBusy == 1)
    #expect(snapshot.inFlight == 0)
}
