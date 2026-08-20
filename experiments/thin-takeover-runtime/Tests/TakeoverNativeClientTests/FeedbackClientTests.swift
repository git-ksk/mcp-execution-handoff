import Foundation
import Testing
@testable import TakeoverCore
@testable import TakeoverNativeClient

@Test func nativeInputConsumesAuthenticatedAckAndStopsRetry() throws {
    let key = Data(repeating: 0x71, count: 32)
    let client = try NativeInputClient(
        rootKey: key,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        retryPolicy: CriticalInputRetryPolicy(retryIntervalNanos: 10, lifetimeNanos: 100, maxAttempts: 4)
    )
    let click = try client.critical(kind: .pointerButton, x: 10, y: 20, value: 1, nowNanos: 100)
    #expect(client.pendingCriticalCount == 1)

    let hostCodec = try SecureFeedbackCodec(
        rootKey: key,
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        direction: .hostToClient,
        channel: .inputFeedback
    )
    let ack = try hostCodec.seal(FeedbackMessage(
        kind: .criticalInputAck,
        sequence: 0,
        reference: click.event.sequence,
        monotonicNanos: 105
    ))
    #expect(try client.ingestFeedback(ack) == .acknowledged(sequence: click.event.sequence))
    #expect(client.pendingCriticalCount == 0)
    #expect(client.dueCriticalRetries(nowNanos: 120).isEmpty)
    #expect(try client.ingestFeedback(ack) == .duplicateOrStale)
}

@Test func nativeVideoIDRRequestIsAuthenticatedAndRateLimited() throws {
    let key = Data(repeating: 0x72, count: 32)
    let client = try NativeVideoFeedbackClient(
        rootKey: key,
        sessionHash: 4,
        epoch: 5,
        generation: 6,
        minIntervalNanos: 100
    )
    let first = try client.requestIDR(afterFrameID: 99, nowNanos: 1_000)
    #expect(first != nil)
    #expect(try client.requestIDR(afterFrameID: 100, nowNanos: 1_050) == nil)
    let second = try client.requestIDR(afterFrameID: 100, nowNanos: 1_100)
    #expect(second != nil)

    let hostCodec = try SecureFeedbackCodec(
        rootKey: key,
        sessionHash: 4,
        epoch: 5,
        generation: 6,
        direction: .clientToHost,
        channel: .videoFeedback
    )
    guard let first else {
        Issue.record("expected first IDR request")
        return
    }
    let opened = try hostCodec.open(first)
    #expect(opened.kind == .requestIDR)
    #expect(opened.reference == 99)
}
