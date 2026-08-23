import AppKit

@MainActor
final class DogfoodTargetDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var statusLabel: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 280),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "CUMG Handoff Dogfood Target — agent_ready"
        window.isReleasedWhenClosed = false
        window.center()

        let content = NSView(frame: window.contentView?.bounds ?? .zero)
        content.autoresizingMask = [.width, .height]

        let title = NSTextField(labelWithString: "Bounded os_window acceptance")
        title.font = .boldSystemFont(ofSize: 18)
        title.alignment = .center
        title.frame = NSRect(x: 60, y: 205, width: 360, height: 28)
        content.addSubview(title)

        let status = NSTextField(labelWithString: "agent_ready")
        status.identifier = NSUserInterfaceItemIdentifier("dogfood-status")
        status.alignment = .center
        status.font = .monospacedSystemFont(ofSize: 17, weight: .medium)
        status.frame = NSRect(x: 90, y: 155, width: 300, height: 28)
        content.addSubview(status)
        status.setAccessibilityValue("agent_ready")
        self.statusLabel = status

        let button = NSButton(title: "Apply Human Interaction", target: self, action: #selector(applyHumanInteraction))
        button.identifier = NSUserInterfaceItemIdentifier("dogfood-human-action")
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 17, weight: .semibold)
        button.frame = NSRect(x: 100, y: 70, width: 280, height: 70)
        content.addSubview(button)

        let hint = NSTextField(labelWithString: "Acceptance succeeds only when the bounded Native Handoff click changes the status above.")
        hint.alignment = .center
        hint.lineBreakMode = .byWordWrapping
        hint.maximumNumberOfLines = 2
        hint.frame = NSRect(x: 40, y: 18, width: 400, height: 42)
        content.addSubview(hint)

        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        self.window = window
    }

    @objc private func applyHumanInteraction() {
        statusLabel?.stringValue = "human_clicked"
        statusLabel?.setAccessibilityValue("human_clicked")
        window?.title = "CUMG Handoff Dogfood Target — human_clicked"
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
@MainActor
struct DogfoodTargetMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = DogfoodTargetDelegate()
        app.delegate = delegate
        app.run()
    }
}
