import Foundation

#if os(macOS)
public enum MacOSWindowMediaProfile: String, Sendable, Equatable {
    case standard
    case windowText = "window_text"
}

public struct MacOSWindowMediaPolicy: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let averageBitrate: Int
    public let frameRate: Int32
    public let prioritizeEncodingSpeedOverQuality: Bool

    public init(
        width: Int,
        height: Int,
        averageBitrate: Int,
        frameRate: Int32,
        prioritizeEncodingSpeedOverQuality: Bool
    ) {
        self.width = width
        self.height = height
        self.averageBitrate = averageBitrate
        self.frameRate = frameRate
        self.prioritizeEncodingSpeedOverQuality = prioritizeEncodingSpeedOverQuality
    }
}

public enum MacOSWindowMediaPolicyError: Error, Equatable {
    case invalidSourceDimensions
}

/// Bounded media policy for the macOS WebRTC host.
///
/// The standard profile is the existing compatibility baseline. `window_text` raises only the
/// media ceiling for first-class Window Handoff; capture authority, frame admission/backpressure,
/// transport selection and input semantics are deliberately outside this policy.
public enum MacOSWindowMediaPolicyResolver {
    public static func resolve(
        nativeWidth: Double,
        nativeHeight: Double,
        profile: MacOSWindowMediaProfile
    ) throws -> MacOSWindowMediaPolicy {
        guard nativeWidth.isFinite, nativeHeight.isFinite, nativeWidth >= 2, nativeHeight >= 2 else {
            throw MacOSWindowMediaPolicyError.invalidSourceDimensions
        }

        let ceiling: (width: Double, height: Double)
        let bitrate: Int
        let speedPriority: Bool
        switch profile {
        case .standard:
            ceiling = (1_280, 720)
            bitrate = 3_000_000
            speedPriority = true
        case .windowText:
            ceiling = (1_920, 1_080)
            bitrate = 5_000_000
            speedPriority = false
        }

        let scale = min(1.0, min(ceiling.width / nativeWidth, ceiling.height / nativeHeight))
        return MacOSWindowMediaPolicy(
            width: evenDimension(nativeWidth * scale),
            height: evenDimension(nativeHeight * scale),
            averageBitrate: bitrate,
            frameRate: 30,
            prioritizeEncodingSpeedOverQuality: speedPriority
        )
    }

    private static func evenDimension(_ value: Double) -> Int {
        let rounded = max(2, Int(value.rounded(.down)))
        return rounded.isMultiple(of: 2) ? rounded : rounded - 1
    }
}
#endif
