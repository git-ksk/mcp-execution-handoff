import Foundation

public struct LatencySummary: Sendable, Equatable {
    public let count: Int
    public let p50Millis: Double
    public let p95Millis: Double
    public let p99Millis: Double
    public let maxMillis: Double
}

public actor LatencyMetrics {
    private var samplesNanos: [UInt64] = []
    private let capacity: Int

    public init(capacity: Int = 10_000) {
        self.capacity = max(32, capacity)
    }

    public func record(nanos: UInt64) {
        if samplesNanos.count == capacity { samplesNanos.removeFirst(capacity / 4) }
        samplesNanos.append(nanos)
    }

    public func summary() -> LatencySummary? {
        guard !samplesNanos.isEmpty else { return nil }
        let sorted = samplesNanos.sorted()
        func percentile(_ p: Double) -> Double {
            let idx = min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))
            return Double(sorted[idx]) / 1_000_000.0
        }
        return LatencySummary(
            count: sorted.count,
            p50Millis: percentile(0.50),
            p95Millis: percentile(0.95),
            p99Millis: percentile(0.99),
            maxMillis: Double(sorted.last!) / 1_000_000.0
        )
    }
}
