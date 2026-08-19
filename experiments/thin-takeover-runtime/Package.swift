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
        .executable(name: "takeover-macos-host", targets: ["takeover-macos-host"]),
    ],
    targets: [
        .target(name: "TakeoverCore"),
        .executableTarget(name: "takeover-loopback", dependencies: ["TakeoverCore"]),
        .executableTarget(name: "takeover-macos-host", dependencies: ["TakeoverCore"]),
        .testTarget(name: "TakeoverCoreTests", dependencies: ["TakeoverCore"]),
    ]
)
