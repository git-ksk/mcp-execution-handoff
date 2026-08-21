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

public enum NativeTakeoverCloseAction: Sendable, Equatable {
    case done
    case cancel
}

private final class ClientRunToken: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    func stop() { lock.lock(); active = false; lock.unlock() }
    var isActive: Bool { lock.lock(); defer { lock.unlock() }; return active }
}

/// Minimal physical-iPhone reference surface for the native takeover path.
///
/// - Tap maps to one left click.
/// - One-finger pan maps to pixel scrolling (there is no implicit mouse drag).
/// - Standard iOS keyboard input is received via UIKeyInput and forwarded immediately; typed text
///   is not accumulated in a local UITextField/string buffer.
/// - Backgrounding destroys the active native session. Foregrounding requires a fresh broker
///   generation/root key before media/input can resume.
@MainActor
public final class TakeoverClientViewController: UIViewController, UIKeyInput {
    public var onRequiresFreshBinding: (() -> Void)?
    public var onCloseRequested: ((NativeTakeoverCloseAction) -> Void)?

    // UITextInputTraits is intentionally configured for credential-safe direct forwarding. These
    // are settable because UIKit declares the traits as optional mutable properties.
    public var autocorrectionType: UITextAutocorrectionType = .no
    public var autocapitalizationType: UITextAutocapitalizationType = .none
    public var spellCheckingType: UITextSpellCheckingType = .no
    public var smartQuotesType: UITextSmartQuotesType = .no
    public var smartDashesType: UITextSmartDashesType = .no
    public var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    public var keyboardType: UIKeyboardType = .default
    public var keyboardAppearance: UIKeyboardAppearance = .default
    public var returnKeyType: UIReturnKeyType = .default
    public var enablesReturnKeyAutomatically: Bool = false
    public var isSecureTextEntry: Bool = false
    public var textContentType: UITextContentType? = nil

    private var pendingBinding: NativeClientSessionBinding?
    private let frameStore = LatestDecodedFrameStore()
    private let metalView = TakeoverMetalView()
    private let cursorView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 14))
    private let controls = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
    private let keyboardButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var session: NativeTakeoverClientSession?
    private var runToken: ClientRunToken?
    private var backgrounded = false
    private var closing = false

    private static let backspaceKeyCode: Int32 = 51
    private static let returnKeyCode: Int32 = 36
    private static let tabKeyCode: Int32 = 48
    private static let escapeKeyCode: Int32 = 53

    public init(binding: NativeClientSessionBinding) {
        self.pendingBinding = binding
        super.init(nibName: nil, bundle: nil)
    }

    public required init?(coder: NSCoder) {
        return nil
    }

    public override var canBecomeFirstResponder: Bool { !closing && session != nil }
    public var hasText: Bool { session != nil }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.isMultipleTouchEnabled = false

        metalView.translatesAutoresizingMaskIntoConstraints = false
        metalView.bind(frameStore: frameStore)
        view.addSubview(metalView)

        controls.translatesAutoresizingMaskIntoConstraints = false
        controls.layer.cornerRadius = 12
        controls.clipsToBounds = true
        view.addSubview(controls)

        let stack = UIStackView(arrangedSubviews: [cancelButton, keyboardButton, doneButton])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.spacing = 8
        controls.contentView.addSubview(stack)

        cancelButton.setTitle("Cancel", for: .normal)
        keyboardButton.setTitle("Keyboard", for: .normal)
        doneButton.setTitle("Done", for: .normal)
        cancelButton.addTarget(self, action: #selector(cancelPressed), for: .touchUpInside)
        keyboardButton.addTarget(self, action: #selector(keyboardPressed), for: .touchUpInside)
        doneButton.addTarget(self, action: #selector(donePressed), for: .touchUpInside)

        cursorView.isUserInteractionEnabled = false
        cursorView.layer.cornerRadius = 7
        cursorView.layer.borderWidth = 1
        cursorView.layer.borderColor = UIColor.black.withAlphaComponent(0.5).cgColor
        cursorView.backgroundColor = UIColor.white.withAlphaComponent(0.85)
        cursorView.isHidden = true
        view.addSubview(cursorView)

        NSLayoutConstraint.activate([
            metalView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            metalView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            metalView.topAnchor.constraint(equalTo: view.topAnchor),
            metalView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            controls.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
            controls.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -10),
            controls.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            controls.heightAnchor.constraint(equalToConstant: 50),

            stack.leadingAnchor.constraint(equalTo: controls.contentView.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: controls.contentView.trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: controls.contentView.topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: controls.contentView.bottomAnchor, constant: -6)
        ])

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.maximumNumberOfTouches = 1
        pan.cancelsTouchesInView = true
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.numberOfTapsRequired = 1
        tap.require(toFail: pan)
        metalView.addGestureRecognizer(pan)
        metalView.addGestureRecognizer(tap)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(willEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )

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
        guard session == nil, !backgrounded, !closing, let binding = pendingBinding else { return }
        let store = frameStore
        let created = try NativeTakeoverClientSession(
            network: binding.network,
            rootKey: binding.rootKey,
            sessionHash: binding.sessionHash,
            epoch: binding.epoch,
            generation: binding.generation,
            decodedFrame: { frame in store.push(frame) }
        )
        // Root-key material is one-generation-only. The pending binding is dropped immediately
        // after constructing the channel ciphers; background/reconnect requires a fresh binding.
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

    public func replaceWithFreshBinding(_ binding: NativeClientSessionBinding) throws {
        stopSession()
        pendingBinding = binding
        backgrounded = false
        closing = false
        try startSession()
    }

    public func stopSession() {
        resignFirstResponder()
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
        guard backgrounded, !closing else { return }
        backgrounded = false
        onRequiresFreshBinding?()
    }

    @objc private func keyboardPressed() {
        if isFirstResponder {
            resignFirstResponder()
            keyboardButton.setTitle("Keyboard", for: .normal)
        } else if becomeFirstResponder() {
            keyboardButton.setTitle("Hide Keyboard", for: .normal)
        }
    }

    @objc private func donePressed() { requestClose(.done) }
    @objc private func cancelPressed() { requestClose(.cancel) }

    private func requestClose(_ action: NativeTakeoverCloseAction) {
        guard !closing else { return }
        closing = true
        stopSession()
        controls.isUserInteractionEnabled = false
        onCloseRequested?(action)
    }

    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, let session else { return }
        let point = recognizer.location(in: metalView)
        updateLocalCursor(point)
        let normalized = normalizedPoint(point, in: metalView.bounds)
        _ = try? session.sendRealtimeInput(kind: .pointerMove, x: normalized.x, y: normalized.y)
        _ = try? session.sendCriticalInput(
            kind: .pointerButton,
            x: normalized.x,
            y: normalized.y,
            value: 1,
            payload: Data([0])
        )
        _ = try? session.sendCriticalInput(
            kind: .pointerButton,
            x: normalized.x,
            y: normalized.y,
            value: 0,
            payload: Data([0])
        )
    }

    @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        guard let session else { return }
        guard recognizer.state == .began || recognizer.state == .changed else { return }
        let translation = recognizer.translation(in: metalView)
        recognizer.setTranslation(.zero, in: metalView)
        let scale: CGFloat = 1.25
        let x = Int32(clamping: Int((-translation.x * scale).rounded()))
        let y = Int32(clamping: Int((-translation.y * scale).rounded()))
        if x != 0 || y != 0 {
            _ = try? session.sendRealtimeInput(kind: .scroll, x: x, y: y)
        }
    }

    private func updateLocalCursor(_ point: CGPoint) {
        let converted = metalView.convert(point, to: view)
        cursorView.center = converted
        cursorView.isHidden = false
    }

    private func normalizedPoint(_ point: CGPoint, in bounds: CGRect) -> (x: Int32, y: Int32) {
        let width = max(bounds.width, 1)
        let height = max(bounds.height, 1)
        let x = min(1.0, max(0.0, (point.x - bounds.minX) / width))
        let y = min(1.0, max(0.0, (point.y - bounds.minY) / height))
        return (Int32((x * 1_000_000).rounded()), Int32((y * 1_000_000).rounded()))
    }

    // MARK: UIKeyInput

    public func insertText(_ text: String) {
        guard let session, !text.isEmpty else { return }
        if text == "\n" || text == "\r" {
            sendKey(Self.returnKeyCode, session: session)
            return
        }
        if text == "\t" {
            sendKey(Self.tabKeyCode, session: session)
            return
        }
        guard let payload = text.data(using: .utf8), payload.count <= 4_096 else { return }
        _ = try? session.sendCriticalInput(kind: .textCommit, payload: payload)
    }

    public func deleteBackward() {
        guard let session else { return }
        sendKey(Self.backspaceKeyCode, session: session)
    }

    /// Optional convenience hooks for a hardware keyboard / reference-app accessory buttons.
    public func sendTab() { if let session { sendKey(Self.tabKeyCode, session: session) } }
    public func sendEscape() { if let session { sendKey(Self.escapeKeyCode, session: session) } }

    private func sendKey(_ keyCode: Int32, session: NativeTakeoverClientSession) {
        _ = try? session.sendCriticalInput(kind: .key, x: keyCode, value: 1)
        _ = try? session.sendCriticalInput(kind: .key, x: keyCode, value: 0)
    }
}
#endif
