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

@Test func windowLineageAdmitsOnlyOneNewSameProcessModalSuccessor() throws {
    let known: Set<CGWindowID> = [11, 12]
    let candidates = [
        MacOSWindowLineageCandidate(processID: 77, windowID: 11, frame: CGRect(x: 10, y: 10, width: 500, height: 400), isOnScreen: true, layer: 0, isFocused: false, isModal: false, isDialog: false),
        MacOSWindowLineageCandidate(processID: 77, windowID: 13, frame: CGRect(x: 40, y: 40, width: 640, height: 360), isOnScreen: true, layer: 0, isFocused: true, isModal: true, isDialog: true)
    ]
    let result = try MacOSWindowLineage.resolveSuccessor(
        candidates: candidates,
        targetProcessID: 77,
        currentWindowID: 11,
        knownWindowIDs: known
    )
    #expect(result.windowID == 13)
}

@Test func windowLineageNeverAdmitsPreexistingSiblingOrOtherProcess() {
    let candidates = [
        MacOSWindowLineageCandidate(processID: 77, windowID: 12, frame: CGRect(x: 0, y: 0, width: 500, height: 400), isOnScreen: true, layer: 0, isFocused: true, isModal: true, isDialog: true),
        MacOSWindowLineageCandidate(processID: 88, windowID: 20, frame: CGRect(x: 0, y: 0, width: 500, height: 400), isOnScreen: true, layer: 0, isFocused: true, isModal: true, isDialog: true)
    ]
    #expect(throws: MacOSWindowLineageResolutionError.noSuccessor) {
        try MacOSWindowLineage.resolveSuccessor(
            candidates: candidates,
            targetProcessID: 77,
            currentWindowID: 11,
            knownWindowIDs: [11, 12]
        )
    }
}

@Test func windowLineageRejectsNewUnrelatedUnfocusedSibling() {
    let candidate = MacOSWindowLineageCandidate(
        processID: 77, windowID: 13, frame: CGRect(x: 0, y: 0, width: 500, height: 400),
        isOnScreen: true, layer: 0, isFocused: false, isModal: false, isDialog: false
    )
    #expect(throws: MacOSWindowLineageResolutionError.noSuccessor) {
        try MacOSWindowLineage.resolveSuccessor(
            candidates: [candidate], targetProcessID: 77, currentWindowID: 11, knownWindowIDs: [11]
        )
    }
}

@Test func windowLineageAllowsFocusedNewSecondaryWindowWithoutModalClaim() throws {
    let candidate = MacOSWindowLineageCandidate(
        processID: 77, windowID: 13, frame: CGRect(x: 0, y: 0, width: 500, height: 400),
        isOnScreen: true, layer: 0, isFocused: true, isModal: false, isDialog: false
    )
    let result = try MacOSWindowLineage.resolveSuccessor(
        candidates: [candidate], targetProcessID: 77, currentWindowID: 11, knownWindowIDs: [11]
    )
    #expect(result.windowID == 13)
}

@Test func windowLineageFailsClosedWhenTwoNewSuccessorsArePlausible() {
    let candidates = [13, 14].map { id in
        MacOSWindowLineageCandidate(
            processID: 77, windowID: CGWindowID(id), frame: CGRect(x: Double(id), y: 0, width: 500, height: 400),
            isOnScreen: true, layer: 0, isFocused: id == 13, isModal: true, isDialog: true
        )
    }
    #expect(throws: MacOSWindowLineageResolutionError.ambiguousSuccessor) {
        try MacOSWindowLineage.resolveSuccessor(
            candidates: candidates, targetProcessID: 77, currentWindowID: 11, knownWindowIDs: [11]
        )
    }
}

@Test func windowLineageReturnsOnlyToImmediateFocusedPredecessorAfterCurrentDisappears() {
    let candidates = [
        MacOSWindowLineageCandidate(processID: 77, windowID: 11, frame: CGRect(x: 0, y: 0, width: 500, height: 400), isOnScreen: true, layer: 0, isFocused: true, isModal: false, isDialog: false),
        MacOSWindowLineageCandidate(processID: 77, windowID: 10, frame: CGRect(x: 20, y: 20, width: 400, height: 300), isOnScreen: true, layer: 0, isFocused: false, isModal: false, isDialog: false)
    ]
    #expect(MacOSWindowLineage.canReturnToPredecessor(
        candidates: candidates,
        targetProcessID: 77,
        currentWindowID: 13,
        predecessorWindowID: 11
    ))
    #expect(!MacOSWindowLineage.canReturnToPredecessor(
        candidates: candidates,
        targetProcessID: 77,
        currentWindowID: 13,
        predecessorWindowID: 10
    ))
}

@Test func windowLineageDoesNotReturnWhileCurrentSuccessorStillExists() {
    let candidates = [
        MacOSWindowLineageCandidate(processID: 77, windowID: 13, frame: CGRect(x: 0, y: 0, width: 600, height: 400), isOnScreen: true, layer: 0, isFocused: false, isModal: true, isDialog: true),
        MacOSWindowLineageCandidate(processID: 77, windowID: 11, frame: CGRect(x: 0, y: 0, width: 500, height: 400), isOnScreen: true, layer: 0, isFocused: true, isModal: false, isDialog: false)
    ]
    #expect(!MacOSWindowLineage.canReturnToPredecessor(
        candidates: candidates,
        targetProcessID: 77,
        currentWindowID: 13,
        predecessorWindowID: 11
    ))
}
@Test func windowLineageAllowsFocusedNonZeroLayerModalDialogSuccessor() throws {
    let candidates = [
        MacOSWindowLineageCandidate(
            processID: 77, windowID: 13, frame: CGRect(x: 100, y: 100, width: 880, height: 448),
            isOnScreen: true, layer: 8, isFocused: true, isModal: true, isDialog: true
        )
    ]
    let resolution = try MacOSWindowLineage.resolveSuccessor(
        candidates: candidates, targetProcessID: 77, currentWindowID: 11, knownWindowIDs: [11]
    )
    #expect(resolution.windowID == 13)
}

@Test func windowLineageRejectsNonZeroLayerWindowWithoutFocusedModalDialogProof() {
    let candidates = [
        MacOSWindowLineageCandidate(
            processID: 77, windowID: 13, frame: CGRect(x: 100, y: 100, width: 880, height: 448),
            isOnScreen: true, layer: 8, isFocused: false, isModal: true, isDialog: true
        ),
        MacOSWindowLineageCandidate(
            processID: 77, windowID: 14, frame: CGRect(x: 120, y: 120, width: 700, height: 400),
            isOnScreen: true, layer: 8, isFocused: true, isModal: false, isDialog: false
        )
    ]
    #expect(throws: MacOSWindowLineageResolutionError.noSuccessor) {
        try MacOSWindowLineage.resolveSuccessor(
            candidates: candidates, targetProcessID: 77, currentWindowID: 11, knownWindowIDs: [11]
        )
    }
}

@Test func windowLineageDoesNotReturnWhileFocusedNonZeroLayerModalDialogStillExists() {
    let candidates = [
        MacOSWindowLineageCandidate(
            processID: 77, windowID: 13, frame: CGRect(x: 100, y: 100, width: 880, height: 448),
            isOnScreen: true, layer: 8, isFocused: true, isModal: true, isDialog: true
        ),
        MacOSWindowLineageCandidate(
            processID: 77, windowID: 11, frame: CGRect(x: 0, y: 0, width: 500, height: 400),
            isOnScreen: true, layer: 0, isFocused: true, isModal: false, isDialog: false
        )
    ]
    #expect(!MacOSWindowLineage.canReturnToPredecessor(
        candidates: candidates,
        targetProcessID: 77,
        currentWindowID: 13,
        predecessorWindowID: 11
    ))
}
