import Foundation
import XCTest

final class LocalizationTests: XCTestCase {
    private let smokeKey = "本地化测试"
    private let overviewKey = "概览"
    private let overflowKey = "GGUF %@ 溢出。"
    private let inputPromptKey = "输入模型 ID、仓库 URL、本地绝对路径或 ssh:// 地址"
    private let utf8SizeKey = "UTF-8 大小"
    private let modelFilesKey = "模型文件"

    private var productionResourceBundle: Bundle {
        get throws {
            let bundleName = "ModelFiles_ModelFiles.bundle"
            if let loadedBundle = Bundle.allBundles.first(where: { $0.bundleURL.lastPathComponent == bundleName }) {
                return loadedBundle
            }

            // SwiftPM places test and target bundles beside each other in the
            // architecture-specific build directory.
            let buildDirectory = Bundle(for: LocalizationTests.self)
                .bundleURL
                .deletingLastPathComponent()
            let resourceBundleURL = buildDirectory.appending(path: bundleName)

            guard let bundle = Bundle(url: resourceBundleURL) else {
                throw NSError(
                    domain: "LocalizationTests",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Unable to load \(resourceBundleURL.path())."]
                )
            }
            return bundle
        }
    }

    func testProductionCatalogKeysAndRuntimeLookups() throws {
        let bundle = try productionResourceBundle
        let catalogURL = bundle.bundleURL.appending(path: "Localizable.xcstrings")
        let catalog = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: catalogURL)) as? [String: Any]
        )
        let strings = try XCTUnwrap(catalog["strings"] as? [String: Any])

        let literalInterpolationKeys = strings.keys.filter { $0.contains("\\(") }
        XCTAssertTrue(literalInterpolationKeys.isEmpty, literalInterpolationKeys.sorted().joined(separator: "\n"))
        XCTAssertNotNil(strings[overviewKey])
        XCTAssertNotNil(strings[overflowKey])

        let toolURL = URL(fileURLWithPath: "/Applications/Xcode.app/Contents/Developer/usr/bin/xcstringstool")
        guard FileManager.default.isExecutableFile(atPath: toolURL.path) else {
            XCTFail("Missing packaging dependency: \(toolURL.path())")
            return
        }

        let outputURL = FileManager.default.temporaryDirectory
            .appending(component: "ModelFilesLocalizationTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outputURL) }

        let process = Process()
        process.executableURL = toolURL
        process.arguments = ["compile", catalogURL.path, "--output-directory", outputURL.path]
        let standardError = Pipe()
        process.standardError = standardError
        try process.run()
        let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            XCTFail(String(decoding: errorData, as: UTF8.self))
            return
        }

        let englishBundle = try XCTUnwrap(Bundle(url: outputURL.appending(path: "en.lproj")))
        let chineseBundle = try XCTUnwrap(Bundle(url: outputURL.appending(path: "zh-Hans.lproj")))
        XCTAssertEqual(englishBundle.localizedString(forKey: overviewKey, value: nil, table: nil), "Overview")
        XCTAssertEqual(englishBundle.localizedString(forKey: overflowKey, value: nil, table: nil), "GGUF %@ overflow.")
        XCTAssertEqual(
            englishBundle.localizedString(forKey: inputPromptKey, value: nil, table: nil),
            "Enter a model ID, repository URL, local absolute path, or ssh:// address"
        )
        XCTAssertEqual(englishBundle.localizedString(forKey: utf8SizeKey, value: nil, table: nil), "UTF-8 Size")
        XCTAssertEqual(englishBundle.localizedString(forKey: modelFilesKey, value: nil, table: nil), "Model files")
        XCTAssertEqual(chineseBundle.localizedString(forKey: overviewKey, value: nil, table: nil), overviewKey)
        XCTAssertEqual(chineseBundle.localizedString(forKey: overflowKey, value: nil, table: nil), overflowKey)
        XCTAssertEqual(chineseBundle.localizedString(forKey: inputPromptKey, value: nil, table: nil), inputPromptKey)
        XCTAssertEqual(chineseBundle.localizedString(forKey: utf8SizeKey, value: nil, table: nil), utf8SizeKey)
        XCTAssertEqual(chineseBundle.localizedString(forKey: modelFilesKey, value: nil, table: nil), modelFilesKey)
    }

    func testProductionCatalogContainsSmokeTranslations() throws {
        let bundle = try productionResourceBundle
        let catalogNames = try FileManager.default.contentsOfDirectory(atPath: bundle.bundlePath)
            .filter { $0.hasSuffix(".xcstrings") }
        XCTAssertEqual(catalogNames, ["Localizable.xcstrings"])

        let catalogURL = bundle.bundleURL.appending(path: "Localizable.xcstrings")
        let catalog = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: catalogURL)) as? [String: Any]
        )
        XCTAssertEqual(catalog["sourceLanguage"] as? String, "zh-Hans")

        let strings = try XCTUnwrap(catalog["strings"] as? [String: Any])
        let entry = try XCTUnwrap(strings[smokeKey] as? [String: Any])
        let translations = try XCTUnwrap(entry["localizations"] as? [String: Any])

        for (language, expectedValue) in ["zh-Hans": smokeKey, "en": "Localization test"] {
            let unit = try XCTUnwrap(
                (translations[language] as? [String: Any])?["stringUnit"] as? [String: Any],
                "Missing \(language) translation"
            )
            XCTAssertEqual(unit["state"] as? String, "translated", language)
            XCTAssertEqual(unit["value"] as? String, expectedValue, language)
        }
    }
}
