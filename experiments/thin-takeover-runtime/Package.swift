// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "thin-takeover-runtime",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(name: "TakeoverCore", targets: ["TakeoverCore"]),
        .library(name: "TakeoverNativeClient", targets: ["TakeoverNativeClient"]),
        .executable(name: "takeover-loopback", targets: ["takeover-loopback"]),
        .executable(name: "takeover-packet-bench", targets: ["takeover-packet-bench"]),
        .executable(name: "takeover-crypto-bench", targets: ["takeover-crypto-bench"]),
        .executable(name: "takeover-vt-bench", targets: ["takeover-vt-bench"]),
        .executable(name: "takeover-vt-codec-bench", targets: ["takeover-vt-codec-bench"]),
        .executable(name: "takeover-control-send", targets: ["takeover-control-send"]),
        .executable(name: "takeover-native-client-pipeline-bench", targets: ["takeover-native-client-pipeline-bench"]),
        .executable(name: "takeover-macos-host", targets: ["takeover-macos-host"]),
        .executable(name: "takeover-webrtc-host", targets: ["takeover-webrtc-host"]),
    ],
    targets: [
        .target(name: "TakeoverCore"),
        .target(name: "TakeoverNativeClient", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-loopback", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-packet-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-crypto-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-vt-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-vt-codec-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-control-send", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-native-client-pipeline-bench", dependencies: ["TakeoverCore", "TakeoverNativeClient"]),
        .executableTarget(name: "takeover-macos-host", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-webrtc-host", dependencies: ["TakeoverCore"]),
        .testTarget(name: "TakeoverCoreTests", dependencies: ["TakeoverCore"]),
        .testTarget(name: "TakeoverNativeClientTests", dependencies: ["TakeoverCore", "TakeoverNativeClient"]),
    ]
)
