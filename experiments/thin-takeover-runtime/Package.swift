// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "thin-takeover-runtime",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "TakeoverCore", targets: ["TakeoverCore"]),
        .executable(name: "takeover-loopback", targets: ["takeover-loopback"]),
        .executable(name: "takeover-packet-bench", targets: ["takeover-packet-bench"]),
        .executable(name: "takeover-crypto-bench", targets: ["takeover-crypto-bench"]),
        .executable(name: "takeover-vt-bench", targets: ["takeover-vt-bench"]),
        .executable(name: "takeover-vt-codec-bench", targets: ["takeover-vt-codec-bench"]),
        .executable(name: "takeover-macos-host", targets: ["takeover-macos-host"]),
    ],
    targets: [
        .target(name: "TakeoverCore"),
        .executableTarget(name: "takeover-loopback", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-packet-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-crypto-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-vt-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-vt-codec-bench", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-macos-host", dependencies: ["TakeoverCore"]),
        .testTarget(name: "TakeoverCoreTests", dependencies: ["TakeoverCore"]),
    ]
)
