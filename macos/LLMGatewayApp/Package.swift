// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "LLMGatewayApp",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "LLMGatewayApp", targets: ["LLMGatewayApp"]),
    ],
    targets: [
        .executableTarget(name: "LLMGatewayApp"),
        .testTarget(name: "LLMGatewayAppTests", dependencies: ["LLMGatewayApp"]),
    ],
    swiftLanguageModes: [.v5]
)
