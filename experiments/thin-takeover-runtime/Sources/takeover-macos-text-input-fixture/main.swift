#if os(macOS)
import AppKit
import Foundation

private struct FixtureState: Codable {
    let pid: Int32
    let windowId: Int
    let focused: Bool
    let text: String
    let tapX: Double
    let tapY: Double
}

@MainActor
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    private let stateURL: URL
    private var window: NSWindow?
    private var textView: NSTextView?
    private var timer: Timer?

    init(statePath: String) {
        self.stateURL = URL(fileURLWithPath: statePath)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 420),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Handoff Native Text Acceptance"
        window.setFrameOrigin(NSPoint(x: 360, y: 260))

        let scroll = NSScrollView(frame: NSRect(x: 32, y: 32, width: 576, height: 320))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder

        let textView = NSTextView(frame: scroll.bounds)
        textView.isEditable = true
        textView.isSelectable = true
        textView.isRichText = false
        textView.string = "AUTO_BASELINE\n"
        textView.delegate = self
        scroll.documentView = textView

        let focusSink = NSButton(frame: NSRect(x: 32, y: 368, width: 180, height: 28))
        focusSink.title = "Initial Focus"
        window.contentView?.addSubview(scroll)
        window.contentView?.addSubview(focusSink)

        self.window = window
        self.textView = textView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        _ = window.makeFirstResponder(focusSink)
        persistState()

        timer = Timer.scheduledTimer(
            timeInterval: 0.05,
            target: self,
            selector: #selector(persistStateTimer),
            userInfo: nil,
            repeats: true
        )
    }

    func textDidChange(_ notification: Notification) {
        persistState()
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        persistState()
    }

    @objc private func persistStateTimer() {
        persistState()
    }

    private func persistState() {
        guard let window, let textView else { return }
        let windowFrame = window.accessibilityFrame()
        let textFrame = textView.accessibilityFrame()
        let tapX = windowFrame.width > 0 ? (textFrame.midX - windowFrame.minX) / windowFrame.width : -1
        let tapY = windowFrame.height > 0 ? (textFrame.midY - windowFrame.minY) / windowFrame.height : -1
        let state = FixtureState(
            pid: getpid(),
            windowId: window.windowNumber,
            focused: window.firstResponder === textView,
            text: textView.string,
            tapX: tapX,
            tapY: tapY
        )
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: fixture <state-path>\n".utf8))
    exit(64)
}

let app = NSApplication.shared
let delegate = FixtureDelegate(statePath: CommandLine.arguments[1])
app.delegate = delegate
app.run()
#else
import Foundation
FileHandle.standardError.write(Data("macOS only\n".utf8))
exit(64)
#endif
