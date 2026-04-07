// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "CCCommanderPackage",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CCLog", targets: ["CCLog"]),
        .library(name: "CCModels", targets: ["CCModels"]),
        .library(name: "CCNetworking", targets: ["CCNetworking"]),
        .library(name: "CCApp", targets: ["CCApp"]),
        .executable(name: "ccc-shadow", targets: ["CCShadowClient"]),
    ],
    targets: [
        .executableTarget(
            name: "CCShadowClient",
            dependencies: ["CCApp", "CCNetworking", "CCModels", "CCLog"],
            path: "Sources/CCShadowClient"
        ),
        .target(
            name: "CCLog",
            path: "Sources/CCLog"
        ),
        .target(
            name: "CCModels",
            path: "Sources/CCModels"
        ),
        .target(
            name: "CCNetworking",
            dependencies: ["CCModels", "CCLog"],
            path: "Sources/CCNetworking"
        ),
        .target(
            name: "CCApp",
            dependencies: ["CCModels", "CCNetworking", "CCLog"],
            path: "Sources/CCApp"
        ),
        .testTarget(
            name: "CCLogTests",
            dependencies: ["CCLog"],
            path: "Tests/CCLogTests"
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
            dependencies: ["CCApp", "CCModels", "CCNetworking", "CCLog"],
            path: "Tests/CCAppTests"
        ),
    ]
)
