import Foundation
import TakeoverCore

@main
struct PacketBench {
    static func main() {
        let frames = Int(CommandLine.arguments.dropFirst().first ?? "2000") ?? 2000
        let payloadBytes = Int(CommandLine.arguments.dropFirst(2).first ?? "131072") ?? 131_072
        let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
        let payload = Data(repeating: 0xA5, count: payloadBytes)

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
            }
        }
        let sliceNanos = MonotonicClock.nowNanos() &- start

        precondition(legacyBytes == sliceBytes)
        let legacyMs = Double(legacyNanos) / 1_000_000.0
        let sliceMs = Double(sliceNanos) / 1_000_000.0
        let speedup = legacyMs / max(sliceMs, 0.000_001)
        print("frames=\(frames) payload_bytes=\(payloadBytes)")
        print("legacy_copy_packetize_ms=\(String(format: "%.3f", legacyMs))")
        print("slice_descriptor_ms=\(String(format: "%.3f", sliceMs))")
        print("descriptor_speedup_x=\(String(format: "%.2f", speedup))")
    }
}
