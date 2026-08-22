import AppKit
import Foundation
import Security
import TakeoverCore

private enum DogfoodClientError: Error, CustomStringConvertible {
    case invalidArguments
    case invalidLocator
    case claimFailed(Int)
    case malformedGrant
    case expiredGrant
    case requestFailed

    var description: String {
        switch self {
        case .invalidArguments: return "usage: takeover-macos-dogfood-client <locator> <x:0-10000> <y:0-10000>"
        case .invalidLocator: return "invalid local takeover locator"
        case .claimFailed(let status): return "native takeover claim failed (HTTP \(status))"
        case .malformedGrant: return "native takeover grant malformed"
        case .expiredGrant: return "native takeover grant expired"
        case .requestFailed: return "native takeover request failed"
        }
    }
}

private struct NativeNetwork: Decodable {
    let host: String
    let inputPort: UInt16
}

private struct NativeBootstrap: Decodable {
    let rootKeyBase64Url: String
    let sessionHashHex: String
    let epoch: UInt64
    let network: NativeNetwork
}

private struct NativeGrant: Decodable {
    let capability: String
    let expiresAt: UInt64
    let clientGeneration: UInt32
    let native: NativeBootstrap
}

private struct LocalNativeClient {
    let baseURL: URL
    let sessionID: String
    let clientBinding: String
    let x: Int32
    let y: Int32
    private(set) var capability: String?
    private var codec: SecureInputCodec?
    private var sender: DatagramSender?
    private var criticalSequence: UInt64 = 0
    private var realtimeSequence: UInt64 = 0

    init(locator: URL, x: Int32, y: Int32) throws {
        guard locator.scheme == "http",
              locator.host == "127.0.0.1" || locator.host == "localhost",
              locator.user == nil,
              locator.password == nil,
              locator.query == nil,
              locator.fragment == nil else { throw DogfoodClientError.invalidLocator }
        let parts = locator.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "takeover", (0...10_000).contains(x), (0...10_000).contains(y) else {
            throw DogfoodClientError.invalidLocator
        }
        var origin = URLComponents()
        origin.scheme = locator.scheme
        origin.host = locator.host
        origin.port = locator.port
        guard let baseURL = origin.url else { throw DogfoodClientError.invalidLocator }
        self.baseURL = baseURL
        self.sessionID = parts[1]
        self.clientBinding = try Self.randomBinding()
        self.x = x
        self.y = y
    }

    mutating func claim() async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "clientHost": "127.0.0.1",
            "videoPort": 47_555,
            "inputFeedbackPort": 47_559,
        ])
        var request = URLRequest(url: apiURL("claim"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("1", forHTTPHeaderField: "x-takeover-native-client")
        request.setValue(clientBinding, forHTTPHeaderField: "x-takeover-client")
        let (data, response) = try await Self.request(request)
        guard response.statusCode == 200 else { throw DogfoodClientError.claimFailed(response.statusCode) }
        guard data.count <= 8_192,
              let grant = try? JSONDecoder().decode(NativeGrant.self, from: data),
              grant.expiresAt > UInt64(Date().timeIntervalSince1970 * 1_000),
              grant.clientGeneration > 0,
              let rootKey = Data(base64URLEncoded: grant.native.rootKeyBase64Url),
              rootKey.count == 32,
              grant.native.sessionHashHex.count == 16,
              let sessionHash = UInt64(grant.native.sessionHashHex, radix: 16) else {
            throw DogfoodClientError.malformedGrant
        }
        self.capability = grant.capability
        self.codec = try SecureInputCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: grant.native.epoch,
            generation: grant.clientGeneration
        )
        self.sender = try DatagramSender(host: grant.native.network.host, port: grant.native.network.inputPort)
    }

    mutating func sendClick() throws {
        guard let codec, let sender else { throw DogfoodClientError.malformedGrant }
        let now = MonotonicClock.nowNanos()
        let move = InputEvent(
            lane: .realtime,
            kind: .pointerMove,
            sequence: realtimeSequence,
            clientNanos: now,
            x: x,
            y: y
        )
        realtimeSequence &+= 1
        try sender.send(try codec.seal(move))
        usleep(20_000)
        for value: Int32 in [1, 0] {
            let event = InputEvent(
                lane: .critical,
                kind: .pointerButton,
                sequence: criticalSequence,
                clientNanos: MonotonicClock.nowNanos(),
                x: x,
                y: y,
                value: value
            )
            criticalSequence &+= 1
            try sender.send(try codec.seal(event))
            usleep(20_000)
        }
    }

    mutating func close(_ operation: String) async throws {
        guard let capability else { throw DogfoodClientError.malformedGrant }
        var request = URLRequest(url: apiURL(operation))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("1", forHTTPHeaderField: "x-takeover-native-client")
        request.setValue(clientBinding, forHTTPHeaderField: "x-takeover-client")
        request.setValue(capability, forHTTPHeaderField: "x-mcp-takeover-capability")
        let (_, response) = try await Self.request(request)
        guard response.statusCode == 200 else { throw DogfoodClientError.requestFailed }
        self.capability = nil
        self.codec = nil
        self.sender = nil
    }

    private func apiURL(_ operation: String) -> URL {
        baseURL.appendingPathComponent("takeover/api/\(operation)/\(sessionID)")
    }

    private static func randomBinding() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw DogfoodClientError.requestFailed
        }
        return Data(bytes).base64URLEncodedString()
    }

    private static func request(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 8
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw DogfoodClientError.requestFailed }
        return (data, response)
    }
}

private extension Data {
    init?(base64URLEncoded text: String) {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padding = (4 - value.count % 4) % 4
        value += String(repeating: "=", count: padding)
        self.init(base64Encoded: value)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

@MainActor
private func alert(title: String, message: String, primary: String, secondary: String? = nil) -> NSApplication.ModalResponse {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: primary)
    if let secondary { alert.addButton(withTitle: secondary) }
    NSApp.activate(ignoringOtherApps: true)
    return alert.runModal()
}

@main
@MainActor
struct DogfoodClientMain {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count == 4,
                  let locator = URL(string: args[1]),
                  let x = Int32(args[2]),
                  let y = Int32(args[3]) else { throw DogfoodClientError.invalidArguments }
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            var client = try LocalNativeClient(locator: locator, x: x, y: y)
            try await client.claim()
            let first = alert(
                title: "CUMG bounded Human handoff",
                message: "This sends one harmless click through the Handoff Native path to the exact CUMG-selected window only.",
                primary: "Send bounded click",
                secondary: "Cancel"
            )
            if first != .alertFirstButtonReturn {
                try await client.close("cancel")
                return
            }
            try client.sendClick()
            _ = alert(
                title: "Interaction sent",
                message: "Confirm the target window changed as expected, then mark Human Done. CUMG will still require fresh postcondition verification before Agent resume.",
                primary: "Human Done"
            )
            try await client.close("done")
        } catch {
            fputs("takeover-macos-dogfood-client refused: \(error)\n", stderr)
            exit(2)
        }
    }
}
