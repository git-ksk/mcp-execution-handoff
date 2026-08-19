import Foundation
import TakeoverCore

@main
struct PacketBench {
    static func main() throws {
        let frames = Int(CommandLine.arguments.dropFirst().first ?? "2000") ?? 2000
        let payloadBytes = Int(CommandLine.arguments.dropFirst(2).first ?? "131072") ?? 131_072
        let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
        let payload = Data(repeating: 0xA5, count: payloadBytes)
        let authenticator = try VideoHeaderAuthenticator(
            rootKey: Data(repeating: 0xA6, count: 32),
            sessionHash: 1,
            epoch: 1,
            generation: 1
        )

        var legacyBytes = 0
        var start = MonotonicClock.nowNanos()
        for frame in 0..<frames {
            let packets = packetizer.packetize(
                payload: payload,
                sessionHash: 1,
                epoch: 1,
                generation: 1,
                frameID: UInt64(frame),
                captureNanos: 1,
                encodeDoneNanos: 2,
                keyframe: false
            )
            for packet in packets { legacyBytes &+= packet.count }
        }
        let legacyNanos = MonotonicClock.nowNanos() &- start

        var sliceBytes = 0
        var packetCount = 0
        start = MonotonicClock.nowNanos()
        for frame in 0..<frames {
            packetizer.forEachPacket(
                payloadBytes: payload.count,
                sessionHash: 1,
                epoch: 1,
                generation: 1,
                frameID: UInt64(frame),
                captureNanos: 1,
                encodeDoneNanos: 2,
                keyframe: false
            ) { slice in
                sliceBytes &+= VideoPacketHeader.encodedSize + slice.payloadRange.count
                packetCount &+= 1
            }
        }
        let sliceNanos = MonotonicClock.nowNanos() &- start

        var authenticatedBytes = 0
        var authAccumulator: UInt64 = 0
        start = MonotonicClock.nowNanos()
        for frame in 0..<frames {
            packetizer.forEachPacket(
                payloadBytes: payload.count,
                sessionHash: 1,
                epoch: 1,
                generation: 1,
                frameID: UInt64(frame),
                captureNanos: 1,
                encodeDoneNanos: 2,
                keyframe: false
            ) { slice in
                let header = authenticator.authenticate(slice.header)
                authenticatedBytes &+= VideoPacketHeader.encodedSize + slice.payloadRange.count
                authAccumulator ^= header.authTagHigh ^ header.authTagLow
            }
        }
        let authenticatedNanos = MonotonicClock.nowNanos() &- start

        precondition(legacyBytes == sliceBytes)
        precondition(sliceBytes == authenticatedBytes)
        _ = authAccumulator

        let legacyMs = Double(legacyNanos) / 1_000_000.0
        let sliceMs = Double(sliceNanos) / 1_000_000.0
        let authenticatedMs = Double(authenticatedNanos) / 1_000_000.0
        let speedup = legacyMs / max(sliceMs, 0.000_001)
        let authenticatedPerFrameMs = authenticatedMs / Double(max(frames, 1))
        let authenticatedPerPacketMicros = authenticatedMs * 1_000.0 / Double(max(packetCount, 1))

        print("frames=\(frames) payload_bytes=\(payloadBytes) packets=\(packetCount)")
        print("legacy_copy_packetize_ms=\(String(format: "%.3f", legacyMs))")
        print("slice_descriptor_ms=\(String(format: "%.3f", sliceMs))")
        print("descriptor_speedup_x=\(String(format: "%.2f", speedup))")
        print("authenticated_descriptor_ms=\(String(format: "%.3f", authenticatedMs))")
        print("authenticated_header_per_frame_ms=\(String(format: "%.4f", authenticatedPerFrameMs))")
        print("authenticated_header_per_packet_us=\(String(format: "%.3f", authenticatedPerPacketMicros))")
    }
}
