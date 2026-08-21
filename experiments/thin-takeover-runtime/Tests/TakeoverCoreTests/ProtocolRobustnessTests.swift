import Foundation
import Testing
@testable import TakeoverCore

private struct DeterministicBytes {
    var state: UInt64 = 0x9E3779B97F4A7C15

    mutating func next() -> UInt8 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return UInt8(truncatingIfNeeded: state)
    }
}

@Test func videoHeaderDecodeRejectsMalformedInputsWithoutTrap() {
    var rng = DeterministicBytes()
    for length in 0...256 {
        var bytes = Data(count: length)
        bytes.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for index in 0..<raw.count { base[index] = rng.next() }
        }
        _ = try? VideoPacketHeader.decode(bytes)
    }
}

@Test func reassemblerBoundsUntrustedRandomDatagrams() throws {
    let key = Data(repeating: 0xA7, count: 32)
    let authenticator = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 10, epoch: 20, generation: 30)
    var reassembler = FrameReassembler(
        sessionHash: 10,
        epoch: 20,
        generation: 30,
        headerAuthenticator: authenticator,
        maxFrameBytes: 64 * 1024,
        maxPacketCount: 128,
        maxDatagramBytes: 1500
    )
    var rng = DeterministicBytes(state: 0xD1B54A32D192ED03)
    var nonDrops = 0
    for index in 0..<2000 {
        let length = index % 1700
        var packet = Data(count: length)
        packet.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for offset in 0..<raw.count { base[offset] = rng.next() }
        }
        let result = reassembler.ingest(packet)
        if result == .incomplete || {
            if case .complete = result { return true }
            return false
        }() {
            nonDrops += 1
        }
    }
    #expect(nonDrops == 0)
}

@Test func authenticatedHeaderMutationNeverReachesAssembly() throws {
    let key = Data(repeating: 0xB8, count: 32)
    let authenticator = try VideoHeaderAuthenticator(rootKey: key, sessionHash: 1, epoch: 2, generation: 3)
    let base = authenticator.authenticate(VideoPacketHeader(
        flags: VideoPacketFlags.avccSample,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        frameID: 4,
        packetIndex: 0,
        packetCount: 1,
        captureNanos: 5,
        encodeDoneNanos: 6
    ))
    var reassembler = FrameReassembler(
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        headerAuthenticator: authenticator
    )
    let encoded = base.encode()
    for offset in 0..<VideoPacketHeader.encodedSize {
        var forged = encoded
        forged[offset] ^= 0x01
        forged.append(0x00)
        #expect(reassembler.ingest(forged) == .droppedInvalid)
    }
}
