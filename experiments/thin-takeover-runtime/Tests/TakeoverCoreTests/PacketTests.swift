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
