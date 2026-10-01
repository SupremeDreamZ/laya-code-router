// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LayaBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "LayaBar",
            path: "Sources/LayaBar"
        ),
        .testTarget(
            name: "LayaBarTests",
            dependencies: ["LayaBar"],
            path: "Tests/LayaBarTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
