import Foundation
#if os(Linux)
import Glibc
#else
import Darwin
#endif

public enum DatagramSocketError: Error {
    case socketCreation(Int32)
    case invalidAddress
    case bind(Int32)
    case send(Int32)
    case receive(Int32)
}

private func datagramSocketType() -> Int32 {
#if os(Linux)
    return Int32(SOCK_DGRAM.rawValue)
#else
    return SOCK_DGRAM
#endif
}

public final class DatagramSender: @unchecked Sendable {
    private let fd: Int32
    private var destination: sockaddr_in

    public init(host: String, port: UInt16) throws {
        fd = socket(AF_INET, datagramSocketType(), Int32(IPPROTO_UDP))
        guard fd >= 0 else { throw DatagramSocketError.socketCreation(errno) }
        var dest = sockaddr_in()
        dest.sin_family = sa_family_t(AF_INET)
        dest.sin_port = port.bigEndian
        let result = host.withCString { inet_pton(AF_INET, $0, &dest.sin_addr) }
        guard result == 1 else { close(fd); throw DatagramSocketError.invalidAddress }
        destination = dest
    }

    deinit { close(fd) }

    public func send(_ data: Data) throws {
        var dest = destination
        let sent: ssize_t = data.withUnsafeBytes { raw in
            withUnsafePointer(to: &dest) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                    sendto(fd, raw.baseAddress, raw.count, 0, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        guard sent == data.count else { throw DatagramSocketError.send(errno) }
    }

    /// Sends one UDP datagram using two iovecs: the small protocol header and a slice of the
    /// already-encoded video payload. This avoids allocating/copying a new payload Data for
    /// every MTU-sized packet on the hot media path.
    public func send(header: VideoPacketHeader, payload: Data, payloadRange: Range<Int>) throws {
        precondition(payloadRange.lowerBound >= 0 && payloadRange.upperBound <= payload.count)
        var dest = destination
        let headerData = header.encode()

        let sent: ssize_t = try headerData.withUnsafeBytes { headerRaw in
            try payload.withUnsafeBytes { payloadRaw in
                let payloadBase = payloadRaw.baseAddress?.advanced(by: payloadRange.lowerBound)
                var vectors = [
                    iovec(
                        iov_base: UnsafeMutableRawPointer(mutating: headerRaw.baseAddress),
                        iov_len: headerRaw.count
                    ),
                    iovec(
                        iov_base: UnsafeMutableRawPointer(mutating: payloadBase),
                        iov_len: payloadRange.count
                    )
                ]

                return try vectors.withUnsafeMutableBufferPointer { vectorBuffer in
                    try withUnsafePointer(to: &dest) { destPtr in
                        var message = msghdr()
                        message.msg_name = UnsafeMutableRawPointer(mutating: destPtr)
                        message.msg_namelen = socklen_t(MemoryLayout<sockaddr_in>.size)
                        message.msg_iov = vectorBuffer.baseAddress
                        message.msg_iovlen = numericCast(vectorBuffer.count)
                        let result = sendmsg(fd, &message, Int32(MSG_DONTWAIT))
                        guard result >= 0 else { throw DatagramSocketError.send(errno) }
                        return result
                    }
                }
            }
        }
        guard sent == headerData.count + payloadRange.count else { throw DatagramSocketError.send(errno) }
    }
}

public final class DatagramReceiver: @unchecked Sendable {
    private let fd: Int32

    public init(
        host: String = "127.0.0.1",
        port: UInt16,
        receiveTimeoutMillis: Int? = nil,
        receiveBufferBytes: Int? = nil
    ) throws {
        fd = socket(AF_INET, datagramSocketType(), Int32(IPPROTO_UDP))
        guard fd >= 0 else { throw DatagramSocketError.socketCreation(errno) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        let result = host.withCString { inet_pton(AF_INET, $0, &addr.sin_addr) }
        guard result == 1 else { close(fd); throw DatagramSocketError.invalidAddress }

        if let receiveBufferBytes {
            precondition(receiveBufferBytes > 0)
            var requested = Int32(clamping: receiveBufferBytes)
            let rc = setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &requested, socklen_t(MemoryLayout<Int32>.size))
            guard rc == 0 else { let e = errno; close(fd); throw DatagramSocketError.receive(e) }
        }

        if let receiveTimeoutMillis {
            precondition(receiveTimeoutMillis >= 0)
            var timeout = timeval()
            timeout.tv_sec = numericCast(receiveTimeoutMillis / 1000)
            timeout.tv_usec = numericCast((receiveTimeoutMillis % 1000) * 1000)
            let rc = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            guard rc == 0 else { let e = errno; close(fd); throw DatagramSocketError.receive(e) }
        }

        let rc = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard rc == 0 else { let e = errno; close(fd); throw DatagramSocketError.bind(e) }
    }

    deinit { close(fd) }

    public func receive(maxBytes: Int = 2048) throws -> Data {
        var buffer = [UInt8](repeating: 0, count: maxBytes)
        let count = recv(fd, &buffer, buffer.count, 0)
        guard count >= 0 else { throw DatagramSocketError.receive(errno) }
        return Data(buffer.prefix(Int(count)))
    }

    /// Uses a socket-level receive deadline configured at init, keeping the common receive
    /// path to one `recv` syscall per datagram instead of `poll` + `recv` for every packet.
    public func receiveOrTimeout(maxBytes: Int = 2048) throws -> Data? {
        var buffer = [UInt8](repeating: 0, count: maxBytes)
        let count = recv(fd, &buffer, buffer.count, 0)
        if count < 0 {
            if errno == EAGAIN || errno == EWOULDBLOCK { return nil }
            throw DatagramSocketError.receive(errno)
        }
        return Data(buffer.prefix(Int(count)))
    }

    /// Convenience path when a one-off deadline is needed. Hot receive loops should prefer a
    /// socket-level timeout so they do not pay an extra poll syscall for every datagram.
    public func receive(maxBytes: Int = 2048, timeoutMillis: Int32) throws -> Data? {
        precondition(timeoutMillis >= 0)
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let ready = poll(&descriptor, 1, timeoutMillis)
        guard ready >= 0 else { throw DatagramSocketError.receive(errno) }
        guard ready > 0 else { return nil }
        return try receive(maxBytes: maxBytes)
    }
}
