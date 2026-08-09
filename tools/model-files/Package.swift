// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ModelFiles",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "ModelFiles", targets: ["ModelFiles"])
    ],
    dependencies: [
        .package(url: "https://github.com/huggingface/swift-transformers.git", exact: "1.3.3"),
        .package(url: "https://github.com/huggingface/swift-jinja.git", from: "2.4.1"),
        .package(url: "https://github.com/gonzalezreal/textual.git", from: "0.5.0")
    ],
    targets: [
        .executableTarget(
            name: "ModelFiles",
            dependencies: [
                .product(name: "Jinja", package: "swift-jinja"),
                .product(name: "Textual", package: "textual"),
                .product(name: "Hub", package: "swift-transformers"),
                .product(name: "Tokenizers", package: "swift-transformers")
            ],
            path: "Sources/ModelFiles",
            exclude: ["Resources"]
        ),
        .testTarget(
            name: "ModelFilesTests",
            dependencies: ["ModelFiles"],
            path: "Tests/ModelFilesTests",
            resources: [.copy("Fixtures")]
        )
    ]
)
