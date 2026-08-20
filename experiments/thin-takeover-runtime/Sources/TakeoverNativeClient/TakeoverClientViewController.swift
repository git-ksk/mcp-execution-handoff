#if os(iOS)
import Foundation
import UIKit

public struct NativeClientSessionBinding: Sendable {
    public let network: NativeClientNetworkConfiguration
    public let rootKey: Data
    public let sessionHash: UInt64
    public let epoch: UInt64
    public let generation: UInt32

    public init(
        network: NativeClientNetworkConfiguration,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32
    ) {
        precondition(rootKey.count == 32)
        self.network = network
        self.rootKey = rootKey
        self.sessionHash = sessionHash
        self.epoch = epoch
        self.generation = generation
    }
}

private final class ClientRunToken: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    func stop() { lock.lock(); active = false; lock.unlock() }
    var isActive: Bool { lock.lock(); defer { lock.unlock() }; return active }
}

/// Minimal iOS reference client for the V4 native path.
///
/// It intentionally does not reconnect itself after backgrounding. The embedding handoff control
/// plane must issue a fresh generation/root key and construct a fresh controller/session. This
/// keeps mobile lifecycle from silently reviving stale Human authority.
@MainActor
public final class TakeoverClientViewController: UIViewController {
    public var onRequiresFreshBinding: (() -> Void)?

    private var pendingBinding: NativeClientSessionBinding?
    private let frameStore = LatestDecodedFrameStore()
    private let metalView = TakeoverMetalView()
    private let cursorView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 14))
    private var session: NativeTakeoverClientSession?
    private var runToken: ClientRunToken?
    private var backgrounded = false

    public init(binding: NativeClientSessionBinding) {
        self.pendingBinding = binding
        super.init(nibName: nil, bundle: nil)
    }

    public required init?(coder: NSCoder) {
        return nil
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.isMultipleTouchEnabled = false
        metalView.frame = view.bounds
        metalView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        metalView.bind(frameStore: frameStore)
        view.addSubview(metalView)

        cursorView.isUserInteractionEnabled = false
        cursorView.layer.cornerRadius = 7
        cursorView.layer.borderWidth = 1
        cursorView.layer.borderColor = UIColor.black.withAlphaComponent(0.5).cgColor
        cursorView.backgroundColor = UIColor.white.withAlphaComponent(0.85)
        cursorView.isHidden = true
        view.addSubview(cursorView)

        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)

        do {
            try startSession()
        } catch {
            stopSession()
            pendingBinding = nil
            onRequiresFreshBinding?()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    public override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stopSession()
    }

    private func startSession() throws {
        guard session == nil, !backgrounded, let binding = pendingBinding else { return }
        let store = frameStore
        let created = try NativeTakeoverClientSession(
            network: binding.network,
            rootKey: binding.rootKey,
            sessionHash: binding.sessionHash,
            epoch: binding.epoch,
            generation: binding.generation,
            decodedFrame: { frame in store.push(frame) }
        )
        // The binding (and its root-key Data) is one-shot. Reconnect/background requires a new
        // control-plane grant rather than retaining and reviving this material.
        pendingBinding = nil
        session = created
        let token = ClientRunToken()
        runToken = token

        DispatchQueue.global(qos: .userInteractive).async {
            while token.isActive {
                do {
                    _ = try created.receiveVideoOnce()
                } catch {
                    _ = try? created.requestIDR(afterFrameID: 0)
                }
            }
        }
        DispatchQueue.global(qos: .userInteractive).async {
            while token.isActive { _ = try? created.receiveInputFeedbackOnce() }
        }
        DispatchQueue.global(qos: .userInitiated).async {
            while token.isActive {
                _ = try? created.flushCriticalRetries()
                Thread.sleep(forTimeInterval: 0.004)
            }
        }
    }

    private func stopSession() {
        runToken?.stop()
        runToken = nil
        session?.invalidate()
        session = nil
        frameStore.clear()
        metalView.clear()
        cursorView.isHidden = true
    }

    @objc private func didEnterBackground() {
        backgrounded = true
        pendingBinding = nil
        stopSession()
    }

    @objc private func willEnterForeground() {
        guard backgrounded else { return }
        backgrounded = false
        onRequiresFreshBinding?()
    }

    public override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first, let session else { return }
        let point = touch.location(in: view)
        updateLocalCursor(point)
        let normalized = normalizedPoint(point)
        _ = try? session.sendRealtimeInput(kind: .pointerMove, x: normalized.x, y: normalized.y)
        _ = try? session.sendCriticalInput(kind: .pointerButton, x: normalized.x, y: normalized.y, value: 1, payload: Data([0]))
    }

    public override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first, let session else { return }
        let point = touch.location(in: view)
        updateLocalCursor(point)
        let normalized = normalizedPoint(point)
        _ = try? session.sendRealtimeInput(kind: .pointerMove, x: normalized.x, y: normalized.y)
    }

    public override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { finishTouch(touches) }
    public override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { finishTouch(touches) }

    private func finishTouch(_ touches: Set<UITouch>) {
        guard let touch = touches.first, let session else { return }
        let point = touch.location(in: view)
        updateLocalCursor(point)
        let normalized = normalizedPoint(point)
        _ = try? session.sendCriticalInput(kind: .pointerButton, x: normalized.x, y: normalized.y, value: 0, payload: Data([0]))
    }

    private func updateLocalCursor(_ point: CGPoint) {
        cursorView.center = point
        cursorView.isHidden = false
    }

    private func normalizedPoint(_ point: CGPoint) -> (x: Int32, y: Int32) {
        let width = max(view.bounds.width, 1)
        let height = max(view.bounds.height, 1)
        let x = min(1.0, max(0.0, point.x / width))
        let y = min(1.0, max(0.0, point.y / height))
        return (Int32((x * 1_000_000).rounded()), Int32((y * 1_000_000).rounded()))
    }
}
#endif
