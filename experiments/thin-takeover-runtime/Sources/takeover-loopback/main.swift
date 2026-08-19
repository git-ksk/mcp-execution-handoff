import Foundation
import TakeoverCore

@main
struct LoopbackProbe {
    static func main() async throws {
        let port: UInt16 = 45555
        let frameCount = Int(CommandLine.arguments.dropFirst().first ?? "600") ?? 600
        let receiver = try DatagramReceiver(port: port)
        let sender = try DatagramSender(host: "127.0.0.1", port: port)
        let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
        let metrics = LatencyMetrics(capacity: frameCount * 4)
        let sessionHash: UInt64 = 0x12345678ABCDEF00

        let receiverTask = Task.detached {
            var seenFrames = Set<UInt64>()
            while seenFrames.count < frameCount {
                let datagram = try receiver.receive()
                let now = MonotonicClock.nowNanos()
                let header = try VideoPacketHeader.decode(datagram)
                if header.packetIndex == 0, seenFrames.insert(header.frameID).inserted {
                    await metrics.record(nanos: now &- header.encodeDoneNanos)
                }
            }
        }

        var payload = Data(count: 32_000)
        payload.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<raw.count { base[i] = UInt8(truncatingIfNeeded: i) }
        }

        let start = MonotonicClock.nowNanos()
        for frame in 0..<frameCount {
            let capture = MonotonicClock.nowNanos()
            let encodeDone = MonotonicClock.nowNanos()
            let packets = packetizer.packetize(
                payload: payload,
                sessionHash: sessionHash,
                epoch: 1,
                generation: 1,
                frameID: UInt64(frame),
                captureNanos: capture,
                encodeDoneNanos: encodeDone,
                keyframe: frame % 120 == 0
            )
            if let firstPacket = packets.first { try sender.send(firstPacket) }
            try await Task.sleep(for: .milliseconds(1))
        }
        try await receiverTask.value
        let elapsedMs = Double(MonotonicClock.nowNanos() - start) / 1_000_000.0

        if let summary = await metrics.summary() {
            print("frames=\(summary.count) elapsed_ms=\(String(format: \"%.1f\", elapsedMs))")
            print("udp_first_packet_latency_ms p50=\(String(format: \"%.3f\", summary.p50Millis)) p95=\(String(format: \"%.3f\", summary.p95Millis)) p99=\(String(format: \"%.3f\", summary.p99Millis)) max=\(String(format: \"%.3f\", summary.maxMillis))")
        }
    }
}
