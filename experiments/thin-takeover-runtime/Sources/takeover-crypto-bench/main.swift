import Foundation
import TakeoverCore

@main
struct CryptoBench {
    static func main() throws {
        let payloadBytes = Int(CommandLine.arguments.dropFirst().first ?? "131072") ?? 131072
        let iterations = Int(CommandLine.arguments.dropFirst(2).first ?? "2000") ?? 2000
        let warmup = min(100, max(10, iterations / 20))
        let cipher = try TransportCipher(rootKey: Data(repeating: 0x5A, count: 32))
        let context = TransportCryptoContext(
            sessionHash: 0xA11CE001,
            epoch: 1,
            generation: 1,
            direction: .hostToClient,
            channel: .video
        )
        let payload = Data(repeating: 0xAB, count: payloadBytes)
        var sealSamples: [Double] = []
        var openSamples: [Double] = []
        sealSamples.reserveCapacity(iterations)
        openSamples.reserveCapacity(iterations)

        for index in 0..<(iterations + warmup) {
            let sequence = UInt64(index)
            let startSeal = MonotonicClock.nowNanos()
            let sealed = try cipher.seal(payload, sequence: sequence, context: context)
            let endSeal = MonotonicClock.nowNanos()
            let startOpen = MonotonicClock.nowNanos()
            let opened = try cipher.open(sealed, sequence: sequence, context: context)
            let endOpen = MonotonicClock.nowNanos()
            precondition(opened.count == payloadBytes)
            if index >= warmup {
                sealSamples.append(Double(endSeal - startSeal) / 1_000_000.0)
                openSamples.append(Double(endOpen - startOpen) / 1_000_000.0)
            }
        }

        func percentile(_ values: [Double], _ p: Double) -> Double {
            let sorted = values.sorted()
            let index = min(sorted.count - 1, Int(Double(sorted.count - 1) * p))
            return sorted[index]
        }

        print("payload_bytes=\(payloadBytes) iterations=\(iterations)")
        print(String(format: "aead_seal_ms p50=%.3f p95=%.3f p99=%.3f", percentile(sealSamples, 0.50), percentile(sealSamples, 0.95), percentile(sealSamples, 0.99)))
        print(String(format: "aead_open_ms p50=%.3f p95=%.3f p99=%.3f", percentile(openSamples, 0.50), percentile(openSamples, 0.95), percentile(openSamples, 0.99)))
    }
}
