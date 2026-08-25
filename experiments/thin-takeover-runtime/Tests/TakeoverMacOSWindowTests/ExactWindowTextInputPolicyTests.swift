#if os(macOS)
import ApplicationServices
import Testing
@testable import TakeoverMacOSWindow

private func decision(
    focusedWindowMatches: Bool = true,
    focusedPIDMatches: Bool = true,
    role: String? = kAXTextAreaRole as String,
    subrole: String? = nil,
    ancestry: MacOSExactWindowTextAncestry = .native,
    selectedTextSettable: Bool = true
) -> MacOSExactWindowTextPolicyDecision {
    MacOSExactWindowTextInputPolicy.decision(
        focusedWindowMatches: focusedWindowMatches,
        focusedPIDMatches: focusedPIDMatches,
        role: role,
        subrole: subrole,
        ancestry: ancestry,
        selectedTextSettable: selectedTextSettable
    )
}

@Test func nativeTextPolicyAllowsOnlyVerifiedOrdinaryEditableControl() {
    #expect(decision() == .allow)
    #expect(decision(role: kAXTextFieldRole as String) == .allow)
    #expect(decision(role: kAXComboBoxRole as String) == .allow)
}

@Test func nativeTextPolicyRejectsWindowOrProcessBoundaryMismatch() {
    #expect(decision(focusedWindowMatches: false) == .rejected)
    #expect(decision(focusedPIDMatches: false) == .rejected)
}

@Test func nativeTextPolicyDoesNotWidenIntoSecureOrWebText() {
    #expect(decision(subrole: kAXSecureTextFieldSubrole as String) == .unsupported)
    #expect(decision(ancestry: .web) == .unsupported)
    #expect(decision(ancestry: .unknown) == .unsupported)
}

@Test func nativeTextPolicyFallsBackOnlyForUnsupportedOrdinaryCapabilities() {
    #expect(decision(role: kAXButtonRole as String) == .unsupported)
    #expect(decision(selectedTextSettable: false) == .unsupported)
}
#endif
