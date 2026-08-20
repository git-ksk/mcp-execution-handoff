import UIKit
import TakeoverNativeClient

@MainActor
final class ReferenceBootstrapViewController: UIViewController {
    private let locatorField = UITextField()
    private let clientHostField = UITextField()
    private let connectButton = UIButton(type: .system)
    private let statusLabel = UILabel()

    private var activeBroker: TakeoverBrokerClient?
    private var activeClientHost: String?
    private weak var activeTakeoverController: TakeoverClientViewController?

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Native Takeover"
        view.backgroundColor = .systemBackground

        locatorField.borderStyle = .roundedRect
        locatorField.placeholder = "https://…/takeover/<opaque-id>"
        locatorField.autocapitalizationType = .none
        locatorField.autocorrectionType = .no
        locatorField.keyboardType = .URL
        locatorField.textContentType = nil
        locatorField.clearButtonMode = .whileEditing

        clientHostField.borderStyle = .roundedRect
        clientHostField.placeholder = "This iPhone LAN IP"
        clientHostField.autocapitalizationType = .none
        clientHostField.autocorrectionType = .no
        clientHostField.keyboardType = .numbersAndPunctuation
        clientHostField.text = NativeClientNetworkAddress.preferredLANIPv4()

        connectButton.setTitle("Start Native Takeover", for: .normal)
        connectButton.configuration = .filled()
        connectButton.addTarget(self, action: #selector(connectPressed), for: .touchUpInside)

        statusLabel.numberOfLines = 0
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.text = "Paste the short-lived takeover locator. Transport keys stay memory-only."

        let note = UILabel()
        note.numberOfLines = 0
        note.font = .preferredFont(forTextStyle: .caption1)
        note.textColor = .secondaryLabel
        note.text = "Reference acceptance app: tap = click, one-finger swipe = scroll, Keyboard = direct standard iOS keyboard input. Backgrounding never resumes the old generation."

        let stack = UIStackView(arrangedSubviews: [locatorField, clientHostField, connectButton, statusLabel, note])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 14
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24)
        ])
    }

    @objc private func connectPressed() {
        guard let text = locatorField.text?.trimmingCharacters(in: .whitespacesAndNewlines),
              let locator = URL(string: text),
              let clientHost = clientHostField.text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !clientHost.isEmpty else {
            statusLabel.text = "A valid takeover locator and iPhone LAN IP are required."
            return
        }

        setConnecting(true, message: "Claiming a fresh native generation…")
        Task { [weak self] in
            guard let self else { return }
            do {
                // The reference app intentionally does not ask for or persist an operator token.
                // Production embeddings can construct TakeoverBrokerClient with an in-memory
                // authenticationHeaders closure supplied by their authenticated gateway flow.
                let broker = try TakeoverBrokerClient(locator: locator)
                let binding = try await broker.claim(clientHost: clientHost)
                self.activeBroker = broker
                self.activeClientHost = clientHost
                self.setConnecting(false, message: "Native generation claimed.")
                self.presentTakeover(binding: binding, broker: broker, clientHost: clientHost)
            } catch {
                self.activeBroker = nil
                self.activeClientHost = nil
                self.setConnecting(false, message: "Native claim failed. The locator may be expired, unauthenticated, already claimed, or unreachable.")
            }
        }
    }

    private func presentTakeover(
        binding: NativeClientSessionBinding,
        broker: TakeoverBrokerClient,
        clientHost: String
    ) {
        let controller = TakeoverClientViewController(binding: binding)
        controller.modalPresentationStyle = .fullScreen
        controller.onCloseRequested = { [weak self, weak controller] action in
            guard let self else { return }
            Task { @MainActor in
                await self.closeBroker(action: action, broker: broker)
                controller?.dismiss(animated: true)
            }
        }
        controller.onRequiresFreshBinding = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.reconnect(broker: broker, clientHost: clientHost, controller: controller)
        }
        activeTakeoverController = controller
        present(controller, animated: true)
    }

    private func reconnect(
        broker: TakeoverBrokerClient,
        clientHost: String,
        controller: TakeoverClientViewController
    ) {
        statusLabel.text = "Foregrounded: requesting a fresh generation…"
        Task { [weak self, weak controller] in
            guard let self, let controller else { return }
            do {
                let binding = try await broker.reconnect(clientHost: clientHost)
                try controller.replaceWithFreshBinding(binding)
                self.statusLabel.text = "Reconnected with a fresh generation."
            } catch {
                self.statusLabel.text = "Reconnect did not receive a fresh generation. Old native media/input remains stopped."
                self.showReconnectFailure(broker: broker, clientHost: clientHost, controller: controller)
            }
        }
    }

    private func showReconnectFailure(
        broker: TakeoverBrokerClient,
        clientHost: String,
        controller: TakeoverClientViewController
    ) {
        guard presentedViewController === controller else { return }
        let alert = UIAlertController(
            title: "Fresh generation required",
            message: "The previous native session will not be resumed. Retry a fresh reconnect or cancel the Human takeover.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self, weak controller] _ in
            guard let self, let controller else { return }
            self.reconnect(broker: broker, clientHost: clientHost, controller: controller)
        })
        alert.addAction(UIAlertAction(title: "Cancel Takeover", style: .destructive) { [weak self, weak controller] _ in
            guard let self else { return }
            controller?.stopSession()
            Task { @MainActor in
                await self.closeBroker(action: .cancel, broker: broker)
                controller?.dismiss(animated: true)
            }
        })
        controller.present(alert, animated: true)
    }

    private func closeBroker(action: NativeTakeoverCloseAction, broker: TakeoverBrokerClient) async {
        do {
            switch action {
            case .done:
                _ = try await broker.done()
                statusLabel.text = "Done revoked the native transport. Authentication still requires fresh post-handoff verification."
            case .cancel:
                _ = try await broker.cancel()
                statusLabel.text = "Native takeover cancelled and revoked."
            }
        } catch {
            // TakeoverBroker revokes its broker generation before host teardown. The client also
            // discards capability/reconnect state on close failure and never resumes locally.
            statusLabel.text = "Close response failed; local native input is stopped and stale authority material was discarded."
        }
        activeBroker = nil
        activeClientHost = nil
        activeTakeoverController = nil
    }

    private func setConnecting(_ connecting: Bool, message: String) {
        connectButton.isEnabled = !connecting
        locatorField.isEnabled = !connecting
        clientHostField.isEnabled = !connecting
        statusLabel.text = message
    }
}
