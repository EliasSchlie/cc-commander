// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "CCCommanderPackage",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CCModels", targets: ["CCModels"]),
        .library(name: "CCNetworking", targets: ["CCNetworking"]),
        .library(name: "CCApp", targets: ["CCApp"]),
    ],
    targets: [
        .target(
            name: "CCModels",
            path: "Sources/CCModels"
        ),
        .target(
            name: "CCNetworking",
            dependencies: ["CCModels"],
            path: "Sources/CCNetworking"
        ),
        .target(
            name: "CCApp",
            dependencies: ["CCModels", "CCNetworking"],
            path: "Sources/CCApp"
        ),
        .testTarget(
            name: "CCModelsTests",
            dependencies: ["CCModels"],
            path: "Tests/CCModelsTests"
        ),
        .testTarget(
            name: "CCNetworkingTests",
            dependencies: ["CCNetworking", "CCModels"],
            path: "Tests/CCNetworkingTests"
        ),
        .testTarget(
            name: "CCAppTests",
            dependencies: ["CCApp", "CCModels", "CCNetworking"],
            path: "Tests/CCAppTests"
        ),
    ]
)
