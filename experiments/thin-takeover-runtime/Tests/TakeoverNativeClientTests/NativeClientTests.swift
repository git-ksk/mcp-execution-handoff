import Foundation
import Testing
@testable import TakeoverCore
@testable import TakeoverNativeClient

private func authenticatedPackets(
    plaintext: Data,
    flags: UInt8,
    frameID: UInt64,
    rootKey: Data,
    sessionHash: UInt64 = 1,
    epoch: UInt64 = 2,
    generation: UInt32 = 3
) throws -> [Data] {
    let cipher = try TransportCipher(rootKey: rootKey)
    let context = TransportCryptoContext(
        sessionHash: sessionHash,
        epoch: epoch,
        generation: generation,
        direction: .hostToClient,
        channel: .video
    )
    let sealed = try cipher.seal(
        plaintext,
        sequence: frameID,
        context: context,
        associatedData: Data([flags])
    )
    let authenticator = try VideoHeaderAuthenticator(
        rootKey: rootKey,
        sessionHash: sessionHash,
        epoch: epoch,
        generation: generation
    )
    let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    var packets: [Data] = []
    packetizer.forEachPacket(
        payloadBytes: sealed.count,
        sessionHash: sessionHash,
        epoch: epoch,
        generation: generation,
        frameID: frameID,
        captureNanos: 100,
        encodeDoneNanos: 200,
        flags: flags
    ) { slice in
        var datagram = authenticator.authenticate(slice.header).encode()
        datagram.append(sealed.subdata(in: slice.payloadRange))
        packets.append(datagram)
    }
    return packets
}

@Test func secureVideoReceiverOpensAuthenticatedSampleOutOfOrder() throws {
    let key = Data(repeating: 0x77, count: 32)
    let plaintext = Data((0..<9000).map { UInt8(truncatingIfNeeded: $0) })
    var receiver = try SecureVideoReceiver(rootKey: key, sessionHash: 1, epoch: 2, generation: 3)
    let packets = try authenticatedPackets(
        plaintext: plaintext,
        flags: VideoPacketFlags.avccSample | VideoPacketFlags.keyframe,
        frameID: 10,
        rootKey: key
    )

    var finalEvent: SecureVideoReceiverEvent = .incomplete
    for packet in packets.reversed() {
        finalEvent = receiver.ingest(packet, nowNanos: 300)
    }
    guard case .avccSample(let opened, let metadata) = finalEvent else {
        Issue.record("expected authenticated AVCC sample")
        return
    }
    #expect(opened == plaintext)
    #expect(metadata.frameID == 10)
    #expect(metadata.keyframe)
    #expect(metadata.captureNanos == 100)
    #expect(metadata.encodeDoneNanos == 200)
    #expect(metadata.receiveDoneNanos == 300)
}

@Test func secureVideoReceiverRejectsForgedRoutingHeader() throws {
    let key = Data(repeating: 0x31, count: 32)
    var receiver = try SecureVideoReceiver(rootKey: key, sessionHash: 1, epoch: 2, generation: 3)
    var packet = try authenticatedPackets(
        plaintext: Data("x".utf8),
        flags: VideoPacketFlags.avccSample,
        frameID: 4,
        rootKey: key
    )[0]
    packet[12] ^= 0x01
    #expect(receiver.ingest(packet) == .droppedInvalid)
}

@Test func secureVideoReceiverRejectsCiphertextTampering() throws {
    let key = Data(repeating: 0x32, count: 32)
    var receiver = try SecureVideoReceiver(rootKey: key, sessionHash: 1, epoch: 2, generation: 3)
    var packets = try authenticatedPackets(
        plaintext: Data(repeating: 0xAA, count: 4000),
        flags: VideoPacketFlags.avccSample,
        frameID: 5,
        rootKey: key
    )
    let last = packets.count - 1
    packets[last][packets[last].index(before: packets[last].endIndex)] ^= 0x01

    var result: SecureVideoReceiverEvent = .incomplete
    for packet in packets { result = receiver.ingest(packet) }
    #expect(result == .droppedAuthentication)
}

@Test func avcDecoderConfigurationParsesParameterSets() throws {
    let avcC = Data([
        1, 0x64, 0x00, 0x1F, 0xFF,
        0xE1,
        0x00, 0x04, 0x67, 0x64, 0x00, 0x1F,
        0x01,
        0x00, 0x02, 0x68, 0xEE
    ])
    let record = try AVCDecoderConfigurationRecord(avcC: avcC)
    #expect(record.nalUnitHeaderLength == 4)
    #expect(record.parameterSets.count == 2)
    #expect(record.parameterSets[0] == Data([0x67, 0x64, 0x00, 0x1F]))
    #expect(record.parameterSets[1] == Data([0x68, 0xEE]))
}

@Test func avcDecoderConfigurationRejectsTruncation() {
    #expect(throws: NativeH264DecoderError.invalidAVCC) {
        _ = try AVCDecoderConfigurationRecord(avcC: Data([1, 2, 3]))
    }
}

@Test func nativeInputRealtimeIsNeverQueuedForRetry() throws {
    let client = try NativeInputClient(
        rootKey: Data(repeating: 0x19, count: 32),
        sessionHash: 1,
        epoch: 2,
        generation: 3
    )
    let first = try client.realtime(kind: .pointerMove, x: 100, y: 200, nowNanos: 10)
    let second = try client.realtime(kind: .pointerMove, x: 300, y: 400, nowNanos: 11)
    #expect(first.event.sequence == 0)
    #expect(second.event.sequence == 1)
    #expect(client.pendingCriticalCount == 0)
    #expect(client.dueCriticalRetries(nowNanos: 100_000_000).isEmpty)
}

@Test func nativeInputCriticalRetriesAreBoundedAndAckable() throws {
    let policy = CriticalInputRetryPolicy(
        retryIntervalNanos: 10,
        lifetimeNanos: 35,
        maxAttempts: 3
    )
    let client = try NativeInputClient(
        rootKey: Data(repeating: 0x20, count: 32),
        sessionHash: 1,
        epoch: 2,
        generation: 3,
        retryPolicy: policy
    )
    let click = try client.critical(kind: .pointerButton, x: 10, y: 20, value: 1, nowNanos: 100)
    #expect(client.pendingCriticalCount == 1)
    #expect(client.dueCriticalRetries(nowNanos: 109).isEmpty)
    let retry1 = client.dueCriticalRetries(nowNanos: 110)
    #expect(retry1.count == 1)
    #expect(retry1[0].event.sequence == click.event.sequence)
    let retry2 = client.dueCriticalRetries(nowNanos: 120)
    #expect(retry2.count == 1)
    #expect(client.dueCriticalRetries(nowNanos: 130).isEmpty)
    #expect(client.pendingCriticalCount == 0)

    let key = try client.critical(kind: .key, x: 12, value: 1, nowNanos: 200)
    client.acknowledgeCritical(sequence: key.event.sequence)
    #expect(client.pendingCriticalCount == 0)
    #expect(client.dueCriticalRetries(nowNanos: 220).isEmpty)
}
