#if os(iOS)
import Foundation
import Darwin

public enum TakeoverBrokerClientError: Error, Equatable {
    case invalidLocator
    case invalidClientAddress
    case unavailable
    case malformedBootstrap
    case expiredBootstrap
    case notClaimed
}

public struct NativeBrokerCloseResult: Sendable, Equatable {
    public let done: Bool
    public let cancelled: Bool

    public init(done: Bool = false, cancelled: Bool = false) {
        self.done = done
        self.cancelled = cancelled
    }
}

/// In-memory broker client for a native Human Takeover generation.
///
/// The locator itself is not authority. The surrounding HTTPS endpoint must authenticate the
/// Human principal before forwarding this request to TakeoverBroker. Callers may provide bounded
/// authentication headers (for example an outer gateway bearer) but this type never persists them.
/// Capability/reconnect material is held only for the lifetime of this object. The transport root
/// key is returned once inside NativeClientSessionBinding and is not retained here.
public final class TakeoverBrokerClient: @unchecked Sendable {
    public typealias AuthenticationHeaders = @Sendable () -> [String: String]

    private struct BrokerNetwork: Decodable {
        let host: String
        let videoPort: UInt16
        let inputPort: UInt16
        let videoFeedbackPort: UInt16
        let inputFeedbackPort: UInt16
    }

    private struct NativeBootstrap: Decodable {
        let rootKeyBase64Url: String
        let sessionHashHex: String
        let network: BrokerNetwork
    }

    private struct BrokerGrant: Decodable {
        let capability: String
        let reconnectHandle: String
        let expiresAt: UInt64
        let clientGeneration: UInt32
        let native: NativeBootstrap
    }

    private struct CloseResponse: Decodable {
        let done: Bool?
        let cancelled: Bool?
        let revoked: Bool?
    }

    private let baseURL: URL
    private let sessionID: String
    private let urlSession: URLSession
    private let authenticationHeaders: AuthenticationHeaders
    private let lock = NSLock()
    private var clientBinding: String
    private var capability: String?
    private var reconnectHandle: String?
    private var generation: UInt32?
    private var expiresAt: UInt64?

    public init(
        locator: URL,
        authenticationHeaders: @escaping AuthenticationHeaders = { [:] }
    ) throws {
        guard locator.scheme == "https" || locator.scheme == "http",
              locator.user == nil,
              locator.password == nil,
              locator.query == nil,
              locator.fragment == nil else {
            throw TakeoverBrokerClientError.invalidLocator
        }
        let components = locator.pathComponents.filter { $0 != "/" }
        guard components.count == 2,
              components[0] == "takeover",
              (8...100).contains(components[1].count),
              components[1].allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else {
            throw TakeoverBrokerClientError.invalidLocator
        }
        var origin = URLComponents()
        origin.scheme = locator.scheme
        origin.host = locator.host
        origin.port = locator.port
        guard let baseURL = origin.url else { throw TakeoverBrokerClientError.invalidLocator }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12

        self.baseURL = baseURL
        self.sessionID = components[1]
        self.authenticationHeaders = authenticationHeaders
        self.urlSession = URLSession(configuration: configuration)
        self.clientBinding = Self.randomBinding()
    }

    deinit {
        urlSession.invalidateAndCancel()
    }

    public func claim(
        clientHost: String,
        videoPort: UInt16 = 45_555,
        inputFeedbackPort: UInt16 = 45_559
    ) async throws -> NativeClientSessionBinding {
        try Self.validateClientHost(clientHost)
        let nextBinding = Self.randomBinding()
        let grant = try await requestGrant(
            operation: "claim",
            clientBinding: nextBinding,
            reconnectHandle: nil,
            clientHost: clientHost,
            videoPort: videoPort,
            inputFeedbackPort: inputFeedbackPort
        )
        return try accept(grant: grant, clientBinding: nextBinding)
    }

    /// Reconnect is explicit and generation-rotating. It must be called only after the old local
    /// media/input session has been stopped; TakeoverBroker independently enforces its idle fence.
    public func reconnect(
        clientHost: String,
        videoPort: UInt16 = 45_555,
        inputFeedbackPort: UInt16 = 45_559
    ) async throws -> NativeClientSessionBinding {
        try Self.validateClientHost(clientHost)
        let currentReconnect = lock.withLock { reconnectHandle }
        guard let currentReconnect else { throw TakeoverBrokerClientError.notClaimed }
        let nextBinding = Self.randomBinding()
        let grant = try await requestGrant(
            operation: "reconnect",
            clientBinding: nextBinding,
            reconnectHandle: currentReconnect,
            clientHost: clientHost,
            videoPort: videoPort,
            inputFeedbackPort: inputFeedbackPort
        )
        return try accept(grant: grant, clientBinding: nextBinding)
    }

    @discardableResult
    public func done() async throws -> NativeBrokerCloseResult {
        try await close(operation: "done")
    }

    @discardableResult
    public func cancel() async throws -> NativeBrokerCloseResult {
        try await close(operation: "cancel")
    }

    public func discardAuthorityMaterial() {
        lock.withLock {
            capability = nil
            reconnectHandle = nil
            generation = nil
            expiresAt = nil
            clientBinding = Self.randomBinding()
        }
    }

    private func requestGrant(
        operation: String,
        clientBinding: String,
        reconnectHandle: String?,
        clientHost: String,
        videoPort: UInt16,
        inputFeedbackPort: UInt16
    ) async throws -> BrokerGrant {
        let body = try JSONSerialization.data(withJSONObject: [
            "clientHost": clientHost,
            "videoPort": Int(videoPort),
            "inputFeedbackPort": Int(inputFeedbackPort)
        ])
        var request = URLRequest(url: apiURL(operation))
        request.httpMethod = "POST"
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("1", forHTTPHeaderField: "x-takeover-native-client")
        request.setValue(clientBinding, forHTTPHeaderField: "x-takeover-client")
        if let reconnectHandle {
            request.setValue(reconnectHandle, forHTTPHeaderField: "x-mcp-takeover-reconnect")
        }
        applyAuthenticationHeaders(to: &request)

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw TakeoverBrokerClientError.unavailable
        }
        guard data.count <= 8_192,
              let grant = try? JSONDecoder().decode(BrokerGrant.self, from: data) else {
            throw TakeoverBrokerClientError.malformedBootstrap
        }
        return grant
    }

    private func accept(grant: BrokerGrant, clientBinding: String) throws -> NativeClientSessionBinding {
        let nowMillis = UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
        guard grant.expiresAt > nowMillis else { throw TakeoverBrokerClientError.expiredBootstrap }
        guard let rootKey = Data(base64URLEncoded: grant.native.rootKeyBase64Url), rootKey.count == 32,
              grant.native.sessionHashHex.count == 16,
              let sessionHash = UInt64(grant.native.sessionHashHex, radix: 16),
              !grant.native.network.host.isEmpty else {
            throw TakeoverBrokerClientError.malformedBootstrap
        }

        let network = NativeClientNetworkConfiguration(
            host: grant.native.network.host,
            videoPort: grant.native.network.videoPort,
            inputPort: grant.native.network.inputPort,
            videoFeedbackPort: grant.native.network.videoFeedbackPort,
            inputFeedbackPort: grant.native.network.inputFeedbackPort
        )
        let binding = NativeClientSessionBinding(
            network: network,
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: UInt64(exactly: grant.clientGeneration == 0 ? 0 : grant.clientGeneration) == nil ? 0 : 0,
            generation: grant.clientGeneration
        )
        // Epoch is not returned separately by the legacy broker grant. The native bootstrap is
        // bound cryptographically to the broker epoch, so the response must carry it explicitly.
        // Reject until that field is available rather than guessing.
        throw EpochRequiredBinding(binding: binding, grant: grant, clientBinding: clientBinding)
    }

    private struct EpochRequiredBinding: Error {
        let binding: NativeClientSessionBinding
        let grant: BrokerGrant
        let clientBinding: String
    }

    private func close(operation: String) async throws -> NativeBrokerCloseResult {
        let state = lock.withLock { (clientBinding, capability) }
        guard let capability = state.1 else { throw TakeoverBrokerClientError.notClaimed }
        var request = URLRequest(url: apiURL(operation))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("1", forHTTPHeaderField: "x-takeover-native-client")
        request.setValue(state.0, forHTTPHeaderField: "x-takeover-client")
        request.setValue(capability, forHTTPHeaderField: "x-mcp-takeover-capability")
        applyAuthenticationHeaders(to: &request)

        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            // The local client still drops all authority material on a close failure. The broker
            // may already have revoked before reporting a native-runtime teardown error.
            discardAuthorityMaterial()
            throw TakeoverBrokerClientError.unavailable
        }
        let result = (try? JSONDecoder().decode(CloseResponse.self, from: data)) ?? CloseResponse(done: nil, cancelled: nil, revoked: nil)
        discardAuthorityMaterial()
        return NativeBrokerCloseResult(done: result.done ?? false, cancelled: result.cancelled ?? false)
    }

    private func applyAuthenticationHeaders(to request: inout URLRequest) {
        for (name, value) in authenticationHeaders() {
            let lowered = name.lowercased()
            guard !lowered.hasPrefix("x-mcp-takeover-"),
                  lowered != "x-takeover-client",
                  lowered != "x-takeover-native-client",
                  lowered != "content-length",
                  !value.contains("\r"), !value.contains("\n") else { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }
    }

    private func apiURL(_ operation: String) -> URL {
        baseURL
            .appending(path: "takeover")
            .appending(path: "api")
            .appending(path: operation)
            .appending(path: sessionID)
    }

    private static func validateClientHost(_ host: String) throws {
        var storage = sockaddr_storage()
        let result = host.withCString { pointer -> Int32 in
            var ipv4 = in_addr()
            if inet_pton(AF_INET, pointer, &ipv4) == 1 { return 1 }
            var ipv6 = in6_addr()
            if inet_pton(AF_INET6, pointer, &ipv6) == 1 { return 1 }
            withUnsafeMutablePointer(to: &storage) { _ in 0 }
            return 0
        }
        guard result == 1 else { throw TakeoverBrokerClientError.invalidClientAddress }
    }

    private static func randomBinding() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess)
        return Data(bytes).base64URLEncodedString()
    }
}

public enum NativeClientNetworkAddress {
    /// Best-effort Wi-Fi/ethernet IPv4 discovery for the reference app. The control plane still
    /// validates the returned IP literal and the runtime remains generation/expiry fenced.
    public static func preferredLANIPv4() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else { return nil }
        defer { freeifaddrs(interfaces) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            let flags = Int32(current.pointee.ifa_flags)
            let up = (flags & IFF_UP) != 0
            let running = (flags & IFF_RUNNING) != 0
            let loopback = (flags & IFF_LOOPBACK) != 0
            if up, running, !loopback, let address = current.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) {
                var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                let result = getnameinfo(
                    address,
                    socklen_t(address.pointee.sa_len),
                    &hostname,
                    socklen_t(hostname.count),
                    nil,
                    0,
                    NI_NUMERICHOST
                )
                if result == 0 {
                    return String(cString: hostname)
                }
            }
            cursor = current.pointee.ifa_next
        }
        return nil
    }
}

private extension Data {
    init?(base64URLEncoded text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder != 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
#endif
