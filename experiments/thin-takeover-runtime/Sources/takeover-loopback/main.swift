import Foundation
import TakeoverCore

private struct FrameReceiveState {
    var received = 0
    var expected = 0
}

private struct ReceiveResult: Sendable {
    let firstLatencies: [UInt64]
    let completeLatencies: [UInt64]
    let receivedPackets: Int
}

@main
struct LoopbackProbe {
    static func main() async throws {
        let port: UInt16 = 45555
        let frameCount = Int(CommandLine.arguments.dropFirst().first ?? "600") ?? 600
        let payloadBytes = Int(CommandLine.arguments.dropFirst(2).first ?? "32000") ?? 32_000
        let paceMillis = Int(CommandLine.arguments.dropFirst(3).first ?? "16") ?? 16
        let receiveBufferBytes = Int(CommandLine.arguments.dropFirst(4).first ?? "262144") ?? 262_144
        let receiver = try DatagramReceiver(
            port: port,
            receiveTimeoutMillis: 250,
            receiveBufferBytes: receiveBufferBytes
        )
        let sender = try DatagramSender(host: "127.0.0.1", port: port)
        let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
        let sessionHash: UInt64 = 0x12345678ABCDEF00
        let rootKey = Data(repeating: 0xA7, count: 32)
        let headerAuthenticator = try VideoHeaderAuthenticator(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: 1,
            generation: 1
        )
        var expectedPacketsPerFrame = 0
        packetizer.forEachPacket(
            payloadBytes: payloadBytes,
            sessionHash: sessionHash,
            epoch: 1,
            generation: 1,
            frameID: 0,
            captureNanos: 0,
            encodeDoneNanos: 0,
            keyframe: false
        ) { _ in expectedPacketsPerFrame += 1 }

        let receiverTask = Task.detached { () throws -> ReceiveResult in
            var states: [UInt64: FrameReceiveState] = [:]
            var firstSeen = Set<UInt64>()
            var firstLatencies: [UInt64] = []
            var completeLatencies: [UInt64] = []
            firstLatencies.reserveCapacity(frameCount)
            completeLatencies.reserveCapacity(frameCount)
            var receivedPackets = 0
            var receiveStorage = [UInt8](repeating: 0, count: 2048)

            while completeLatencies.count < frameCount {
                let count = try receiveStorage.withUnsafeMutableBytes { raw in
                    try receiver.receiveOrTimeout(into: raw)
                }
                guard let count else { break }
                let now = MonotonicClock.nowNanos()
                let header = try receiveStorage.withUnsafeBytes { raw in
                    try VideoPacketHeader.decode(UnsafeRawBufferPointer(rebasing: raw[..<count]))
                }
                guard headerAuthenticator.verify(header) else { continue }
                receivedPackets += 1

                if firstSeen.insert(header.frameID).inserted {
                    firstLatencies.append(now &- header.encodeDoneNanos)
                }

                var state = states[header.frameID] ?? FrameReceiveState()
                state.received += 1
                state.expected = Int(header.packetCount)
                if state.received >= state.expected {
                    states.removeValue(forKey: header.frameID)
                    completeLatencies.append(now &- header.encodeDoneNanos)
                } else {
                    states[header.frameID] = state
                }
            }
            return ReceiveResult(
                firstLatencies: firstLatencies,
                completeLatencies: completeLatencies,
                receivedPackets: receivedPackets
            )
        }

        var payload = Data(count: payloadBytes)
        payload.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<raw.count { base[i] = UInt8(truncatingIfNeeded: i) }
        }

        let start = MonotonicClock.nowNanos()
        for frame in 0..<frameCount {
            let capture = MonotonicClock.nowNanos()
            let encodeDone = MonotonicClock.nowNanos()
            try packetizer.forEachPacket(
                payloadBytes: payload.count,
                sessionHash: sessionHash,
                epoch: 1,
                generation: 1,
                frameID: UInt64(frame),
                captureNanos: capture,
                encodeDoneNanos: encodeDone,
                keyframe: frame % 120 == 0
            ) { slice in
                let authenticatedHeader = headerAuthenticator.authenticate(slice.header)
                try sender.send(header: authenticatedHeader, payload: payload, payloadRange: slice.payloadRange)
            }
            if paceMillis > 0 { try await Task.sleep(for: .milliseconds(paceMillis)) }
        }
        let result = try await receiverTask.value
        let elapsedMs = Double(MonotonicClock.nowNanos() - start) / 1_000_000.0
        let expectedPackets = expectedPacketsPerFrame * frameCount
        let packetDelivery = expectedPackets == 0 ? 1 : Double(result.receivedPackets) / Double(expectedPackets)
        let frameCompletion = frameCount == 0 ? 1 : Double(result.completeLatencies.count) / Double(frameCount)

        print("authenticated_headers=true frames_sent=\(frameCount) frames_complete=\(result.completeLatencies.count) payload_bytes=\(payloadBytes) pace_ms=\(paceMillis) receive_buffer_bytes=\(receiveBufferBytes) elapsed_ms=\(String(format: "%.1f", elapsedMs))")
        print("packet_delivery_ratio=\(String(format: "%.5f", packetDelivery)) frame_completion_ratio=\(String(format: "%.5f", frameCompletion))")
        if let first = LatencySummary.summarize(samplesNanos: result.firstLatencies) {
            print("udp_first_packet_latency_ms p50=\(String(format: "%.3f", first.p50Millis)) p95=\(String(format: "%.3f", first.p95Millis)) p99=\(String(format: "%.3f", first.p99Millis)) max=\(String(format: "%.3f", first.maxMillis))")
        }
        if let complete = LatencySummary.summarize(samplesNanos: result.completeLatencies) {
            print("udp_complete_frame_latency_ms p50=\(String(format: "%.3f", complete.p50Millis)) p95=\(String(format: "%.3f", complete.p95Millis)) p99=\(String(format: "%.3f", complete.p99Millis)) max=\(String(format: "%.3f", complete.maxMillis))")
        }
    }
}
