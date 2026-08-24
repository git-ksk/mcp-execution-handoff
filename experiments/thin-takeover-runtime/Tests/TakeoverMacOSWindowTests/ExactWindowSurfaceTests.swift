#if os(macOS)
import CoreGraphics
import Testing
@testable import TakeoverMacOSWindow

private let display = MacOSDisplayCandidate(
    displayID: 7,
    frame: CGRect(x: 100, y: 50, width: 1_920, height: 1_080)
)

@Test func exactWindowGeometrySelectsOneBoundedWindowAndDisplayLocalCrop() throws {
    let window = MacOSWindowCandidate(
        processID: 42,
        windowID: 99,
        frame: CGRect(x: 300, y: 150, width: 900, height: 600),
        isOnScreen: true,
        layer: 0
    )
    let resolution = try MacOSExactWindowGeometry.resolve(
        windows: [window],
        displays: [display],
        targetProcessID: 42,
        targetWindowID: 99
    )
    #expect(resolution.windowIndex == 0)
    #expect(resolution.displayIndex == 0)
    #expect(resolution.inputBounds == window.frame)
    #expect(resolution.sourceRect == CGRect(x: 200, y: 100, width: 900, height: 600))
}

@Test func exactWindowGeometryFailsClosedOnAmbiguousProcessWindows() {
    let first = MacOSWindowCandidate(
        processID: 42,
        windowID: 1,
        frame: CGRect(x: 200, y: 100, width: 800, height: 500),
        isOnScreen: true,
        layer: 0
    )
    let second = MacOSWindowCandidate(
        processID: 42,
        windowID: 2,
        frame: CGRect(x: 400, y: 200, width: 800, height: 500),
        isOnScreen: true,
        layer: 0
    )
    #expect(throws: MacOSExactWindowResolutionError.windowUnavailable) {
        try MacOSExactWindowGeometry.resolve(
            windows: [first, second],
            displays: [display],
            targetProcessID: 42,
            targetWindowID: nil
        )
    }
}

@Test func exactWindowGeometryRejectsWindowOwnedByAnotherProcess() {
    let window = MacOSWindowCandidate(
        processID: 43,
        windowID: 99,
        frame: CGRect(x: 300, y: 150, width: 900, height: 600),
        isOnScreen: true,
        layer: 0
    )
    #expect(throws: MacOSExactWindowResolutionError.windowUnavailable) {
        try MacOSExactWindowGeometry.resolve(
            windows: [window],
            displays: [display],
            targetProcessID: 42,
            targetWindowID: 99
        )
    }
}

@Test func exactWindowGeometryRequiresExactlyOneContainingDisplay() {
    let window = MacOSWindowCandidate(
        processID: 42,
        windowID: 99,
        frame: CGRect(x: 300, y: 150, width: 900, height: 600),
        isOnScreen: true,
        layer: 0
    )
    let overlapping = MacOSDisplayCandidate(
        displayID: 8,
        frame: CGRect(x: 0, y: 0, width: 2_560, height: 1_440)
    )
    #expect(throws: MacOSExactWindowResolutionError.containingDisplayUnavailable) {
        try MacOSExactWindowGeometry.resolve(
            windows: [window],
            displays: [display, overlapping],
            targetProcessID: 42,
            targetWindowID: 99
        )
    }
}

@Test func exactWindowGeometryRejectsHiddenLayeredAndUndersizedCandidates() {
    let hidden = MacOSWindowCandidate(
        processID: 42,
        windowID: 1,
        frame: CGRect(x: 300, y: 150, width: 900, height: 600),
        isOnScreen: false,
        layer: 0
    )
    let layered = MacOSWindowCandidate(
        processID: 42,
        windowID: 2,
        frame: CGRect(x: 300, y: 150, width: 900, height: 600),
        isOnScreen: true,
        layer: 1
    )
    let tiny = MacOSWindowCandidate(
        processID: 42,
        windowID: 3,
        frame: CGRect(x: 300, y: 150, width: 120, height: 80),
        isOnScreen: true,
        layer: 0
    )
    #expect(throws: MacOSExactWindowResolutionError.windowUnavailable) {
        try MacOSExactWindowGeometry.resolve(
            windows: [hidden, layered, tiny],
            displays: [display],
            targetProcessID: 42,
            targetWindowID: nil
        )
    }
}

@Test func exactWindowInputFrameMatchingIsBoundedAndToleranceAware() {
    let expected = CGRect(x: 100, y: 200, width: 800, height: 600)
    #expect(MacOSExactWindowGeometry.framesMatch(
        CGRect(x: 101.5, y: 198.5, width: 801.5, height: 599),
        expected
    ))
    #expect(!MacOSExactWindowGeometry.framesMatch(
        CGRect(x: 103, y: 200, width: 800, height: 600),
        expected
    ))
    #expect(!MacOSExactWindowGeometry.framesMatch(expected, expected, tolerance: -1))
}
#endif
