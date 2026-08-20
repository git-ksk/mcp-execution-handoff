import Foundation
import TakeoverCore

public struct NativeClientNetworkConfiguration: Sendable, Equatable {
    public let host: String
    public let videoBindHost: String
    public let inputFeedbackBindHost: String
    public let videoPort: UInt16
    public let inputPort: UInt16
    public let videoFeedbackPort: UInt16
    public let inputFeedbackPort: UInt16
    public let receiveBufferBytes: Int

    public init(
        host: String,
        videoBindHost: String = "0.0.0.0",
        inputFeedbackBindHost: String = "0.0.0.0",
        videoPort: UInt16 = 45_555,
        inputPort: UInt16 = 45_556,
        videoFeedbackPort: UInt16 = 45_558,
        inputFeedbackPort: UInt16 = 45_559,
        receiveBufferBytes: Int = 512 * 1024
    ) {
        precondition(!host.isEmpty)
        precondition(!videoBindHost.isEmpty)
        precondition(!inputFeedbackBindHost.isEmpty)
        precondition(receiveBufferBytes >= 64 * 1024)
        precondition(Set([videoPort, inputPort, videoFeedbackPort, inputFeedbackPort]).count == 4)
        self.host = host
        self.videoBindHost = videoBindHost
        self.inputFeedbackBindHost = inputFeedbackBindHost
        self.videoPort = videoPort
        self.inputPort = inputPort
        self.videoFeedbackPort = videoFeedbackPort
        self.inputFeedbackPort = inputFeedbackPort
        self.receiveBufferBytes = receiveBufferBytes
    }
}

/// Thin native-client network session for the V4 custom-UDP path.
///
/// This class intentionally does not own authority, user identity, Done/Cancel, or reconnect
/// grants. The embedding app supplies a currently valid handoff binding and is responsible for
/// discarding this object when that generation is revoked or replaced.
///
/// Receive methods are single-step/nonblocking-with-timeout building blocks so UIKit lifecycle
/// code can place them on its own high-priority task/queue without hidden background ownership.
public final class NativeTakeoverClientSession: @unchecked Sendable {
    private let videoReceiver: DatagramReceiver
    private let inputFeedbackReceiver: DatagramReceiver
    private let inputSender: DatagramSender
    private let videoFeedbackSender: DatagramSender
    private let videoPipeline: NativeVideoClientPipeline
    private let inputClient: NativeInputClient
    private let videoFeedbackClient: NativeVideoFeedbackClient

    public init(
        network: NativeClientNetworkConfiguration,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        decodedFrame: @escaping VideoToolboxH264Decoder.Output
    ) throws {
        self.videoReceiver = try DatagramReceiver(
            host: network.videoBindHost,
            port: network.videoPort,
            receiveTimeoutMillis: 8,
            receiveBufferBytes: network.receiveBufferBytes
        )
        self.inputFeedbackReceiver = try DatagramReceiver(
            host: network.inputFeedbackBindHost,
            port: network.inputFeedbackPort,
            receiveTimeoutMillis: 8,
            receiveBufferBytes: 64 * 1024
        )
        self.inputSender = try DatagramSender(host: network.host, port: network.inputPort)
        self.videoFeedbackSender = try DatagramSender(host: network.host, port: network.videoFeedbackPort)
        self.videoPipeline = try NativeVideoClientPipeline(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            output: decodedFrame
        )
        self.inputClient = try NativeInputClient(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.videoFeedbackClient = try NativeVideoFeedbackClient(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
    }

    /// Receives at most one video datagram. nil means socket timeout/no packet.
    @discardableResult
    public func receiveVideoOnce() throws -> SecureVideoReceiverEvent? {
        guard let datagram = try videoReceiver.receiveOrTimeout(maxBytes: 2_048) else { return nil }
        return try videoPipeline.ingest(datagram)
    }

    /// Receives at most one authenticated critical-input ACK.
    @discardableResult
    public func receiveInputFeedbackOnce() throws -> NativeInputFeedbackResult? {
        guard let datagram = try inputFeedbackReceiver.receiveOrTimeout(maxBytes: 4_096) else { return nil }
        return try inputClient.ingestFeedback(datagram)
    }

    @discardableResult
    public func sendRealtimeInput(
        kind: InputEventKind,
        x: Int32 = 0,
        y: Int32 = 0,
        value: Int32 = 0,
        payload: Data = Data(),
        nowNanos: UInt64 = MonotonicClock.nowNanos()
    ) throws -> UInt64 {
        let transmission = try inputClient.realtime(
            kind: kind,
            x: x,
            y: y,
            value: value,
            payload: payload,
            nowNanos: nowNanos
        )
        try inputSender.send(transmission.datagram)
        return transmission.event.sequence
    }

    @discardableResult
    public func sendCriticalInput(
        kind: InputEventKind,
        x: Int32 = 0,
        y: Int32 = 0,
        value: Int32 = 0,
        payload: Data = Data(),
        nowNanos: UInt64 = MonotonicClock.nowNanos()
    ) throws -> UInt64 {
        let transmission = try inputClient.critical(
            kind: kind,
            x: x,
            y: y,
            value: value,
            payload: payload,
            nowNanos: nowNanos
        )
        try inputSender.send(transmission.datagram)
        return transmission.event.sequence
    }

    /// Sends only currently-due bounded retries. There is no unbounded critical-input queue.
    @discardableResult
    public func flushCriticalRetries(nowNanos: UInt64 = MonotonicClock.nowNanos()) throws -> Int {
        let retries = inputClient.dueCriticalRetries(nowNanos: nowNanos)
        for transmission in retries { try inputSender.send(transmission.datagram) }
        return retries.count
    }

    /// Requests a new IDR only when the client-side rate limit allows it.
    @discardableResult
    public func requestIDR(
        afterFrameID frameID: UInt64,
        nowNanos: UInt64 = MonotonicClock.nowNanos()
    ) throws -> Bool {
        guard let datagram = try videoFeedbackClient.requestIDR(afterFrameID: frameID, nowNanos: nowNanos) else {
            return false
        }
        try videoFeedbackSender.send(datagram)
        return true
    }

    public func invalidate() {
        inputClient.cancelPendingCritical()
        videoPipeline.flush()
    }
}
