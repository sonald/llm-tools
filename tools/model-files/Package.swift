// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ModelFiles",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ModelFiles", targets: ["ModelFiles"])
    ],
    dependencies: [
        .package(url: "https://github.com/huggingface/swift-jinja.git", from: "2.4.1")
    ],
    targets: [
        .executableTarget(
            name: "ModelFiles",
            dependencies: [
                .product(name: "Jinja", package: "swift-jinja")
            ],
            path: "Sources/ModelFiles",
            exclude: ["Resources"]
        ),
        .testTarget(
            name: "ModelFilesTests",
            dependencies: ["ModelFiles"],
            path: "Tests/ModelFilesTests"
        )
    ]
)
