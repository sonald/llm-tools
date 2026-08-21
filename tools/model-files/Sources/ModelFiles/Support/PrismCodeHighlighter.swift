import Foundation
import JavaScriptCore

struct PrismCodeToken: Sendable {
    let content: String
    let type: String
}

actor PrismCodeHighlighter {
    static let shared = PrismCodeHighlighter()

    private let context: JSContext?

    init() {
        guard let context = JSContext(),
              let scriptURL = Self.prismScriptURL(),
              let script = try? String(contentsOf: scriptURL, encoding: .utf8)
        else {
            self.context = nil
            return
        }
        context.evaluateScript(script)
        self.context = context
    }

    func tokenize(_ source: String, language: String) -> [PrismCodeToken] {
        let fallback = [PrismCodeToken(content: source, type: "plain")]
        guard let context,
              let tokenizeCode = context.objectForKeyedSubscript("tokenizeCode"),
              let result = tokenizeCode.call(withArguments: [source, language]),
              let array = result.toArray() as? [[String: String]]
        else {
            return fallback
        }

        let tokens = array.compactMap { token -> PrismCodeToken? in
            guard let content = token["content"], let type = token["type"] else {
                return nil
            }
            return PrismCodeToken(content: content, type: type)
        }
        guard !tokens.isEmpty, tokens.map(\.content).joined() == source else {
            return fallback
        }
        return tokens
    }

    private static func prismScriptURL() -> URL? {
        var roots: [URL] = []
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["PACKAGE_RESOURCE_BUNDLE_PATH"]
            ?? ProcessInfo.processInfo.environment["PACKAGE_RESOURCE_BUNDLE_URL"]
        {
            roots.append(URL(fileURLWithPath: override))
        }
        #endif
        roots.append(contentsOf: [
            Bundle.main.resourceURL,
            Bundle(for: Marker.self).resourceURL,
            Bundle.main.bundleURL,
            Bundle(for: Marker.self).bundleURL,
            Bundle.main.executableURL?.deletingLastPathComponent(),
        ].compactMap { $0 })

        let fileManager = FileManager.default
        var seen = Set<String>()
        for root in roots {
            var directory = root
            for _ in 0..<5 {
                let script = directory.appendingPathComponent("textual_Textual.bundle/prism-bundle.js")
                let path = script.path
                if seen.insert(path).inserted, fileManager.fileExists(atPath: path) {
                    return script
                }
                let parent = directory.deletingLastPathComponent()
                if parent.path == directory.path { break }
                directory = parent
            }
        }
        return nil
    }

    private final class Marker {}
}
