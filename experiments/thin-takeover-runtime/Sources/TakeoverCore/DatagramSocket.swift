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
}

public final class DatagramReceiver: @unchecked Sendable {
    private let fd: Int32

    public init(host: String = "127.0.0.1", port: UInt16) throws {
        fd = socket(AF_INET, datagramSocketType(), Int32(IPPROTO_UDP))
        guard fd >= 0 else { throw DatagramSocketError.socketCreation(errno) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        let result = host.withCString { inet_pton(AF_INET, $0, &addr.sin_addr) }
        guard result == 1 else { close(fd); throw DatagramSocketError.invalidAddress }
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
}
