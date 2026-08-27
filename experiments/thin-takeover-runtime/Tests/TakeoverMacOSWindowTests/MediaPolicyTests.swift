import Testing
@testable import TakeoverMacOSWindow

#if os(macOS)
@Test func standardMediaPolicyPreservesExisting720pThreeMbpsBaseline() throws {
    let policy = try MacOSWindowMediaPolicyResolver.resolve(
        nativeWidth: 1_600,
        nativeHeight: 1_200,
        profile: .standard
    )
    #expect(policy.width == 960)
    #expect(policy.height == 720)
    #expect(policy.averageBitrate == 3_000_000)
    #expect(policy.frameRate == 30)
    #expect(policy.prioritizeEncodingSpeedOverQuality)
}

@Test func windowTextMediaPolicyRaisesBoundedCeilingWithoutUpscaling() throws {
    let large = try MacOSWindowMediaPolicyResolver.resolve(
        nativeWidth: 1_600,
        nativeHeight: 1_200,
        profile: .windowText
    )
    #expect(large.width == 1_440)
    #expect(large.height == 1_080)
    #expect(large.averageBitrate == 5_000_000)
    #expect(large.frameRate == 30)
    #expect(!large.prioritizeEncodingSpeedOverQuality)

    let small = try MacOSWindowMediaPolicyResolver.resolve(
        nativeWidth: 1_000,
        nativeHeight: 700,
        profile: .windowText
    )
    #expect(small.width == 1_000)
    #expect(small.height == 700)
}

@Test func windowTextMediaPolicyKeepsOutputEvenAndRejectsInvalidSources() throws {
    let policy = try MacOSWindowMediaPolicyResolver.resolve(
        nativeWidth: 1_447,
        nativeHeight: 1_331,
        profile: .windowText
    )
    #expect(policy.width.isMultiple(of: 2))
    #expect(policy.height.isMultiple(of: 2))
    #expect(policy.width <= 1_920)
    #expect(policy.height <= 1_080)

    #expect(throws: MacOSWindowMediaPolicyError.invalidSourceDimensions) {
        try MacOSWindowMediaPolicyResolver.resolve(nativeWidth: 0, nativeHeight: 720, profile: .windowText)
    }
}
#endif
