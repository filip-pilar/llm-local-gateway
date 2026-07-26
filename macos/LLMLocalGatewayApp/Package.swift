// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "LLMLocalGatewayApp",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "LLMLocalGatewayApp", targets: ["LLMLocalGatewayApp"]),
    ],
    targets: [
        .executableTarget(name: "LLMLocalGatewayApp"),
        .testTarget(
            name: "LLMLocalGatewayAppTests",
            dependencies: ["LLMLocalGatewayApp"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
