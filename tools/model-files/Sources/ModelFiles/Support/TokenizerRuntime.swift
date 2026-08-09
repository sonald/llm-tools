import Foundation
import Hub
import Tokenizers

actor TokenizerRuntime {
    enum RuntimeError: LocalizedError {
        case invalidTokenizerData(String)
        case invalidTokenizerConfig(String)
        case unsupported(String)

        var errorDescription: String? {
            switch self {
            case let .invalidTokenizerData(message):
                "tokenizer.json 无效：\(message)"
            case let .invalidTokenizerConfig(message):
                "tokenizer_config.json 无效：\(message)"
            case let .unsupported(message):
                "当前运行时无法加载该 tokenizer：\(message)"
            }
        }
    }

    private let tokenizer: any Tokenizer

    init(bundle: TokenizerBundle) throws {
        let tokenizerData: Config
        do {
            tokenizerData = try JSONDecoder().decode(Config.self, from: bundle.tokenizerData)
        } catch {
            throw RuntimeError.invalidTokenizerData(error.localizedDescription)
        }

        let tokenizerConfig: Config
        do {
            tokenizerConfig = try bundle.tokenizerConfigData.map {
                try JSONDecoder().decode(Config.self, from: $0)
            } ?? Config([String: Config]())
        } catch {
            throw RuntimeError.invalidTokenizerConfig(error.localizedDescription)
        }

        do {
            tokenizer = try AutoTokenizer.from(
                tokenizerConfig: tokenizerConfig,
                tokenizerData: tokenizerData,
                strict: true
            )
        } catch {
            throw RuntimeError.unsupported(error.localizedDescription)
        }
    }

    func tokenize(_ input: String) -> TokenizationResult {
        let tokenIDs = tokenizer.encode(text: input, addSpecialTokens: false)
        let tokenPieces = tokenizer.convertIdsToTokens(tokenIDs)
        let decodedText = tokenizer.decode(tokens: tokenIDs, skipSpecialTokens: false)
        let segments = Self.makeSegments(
            tokenIDs: tokenIDs,
            decodedText: decodedText,
            decode: { tokenizer.decode(tokens: $0, skipSpecialTokens: false) }
        )
        let reconstructed = segments.map(\.text).joined()
        return TokenizationResult(
            input: input,
            tokenIDs: tokenIDs,
            tokenPieces: tokenPieces,
            decodedText: decodedText,
            segments: segments,
            sourceMapping: reconstructed == input && decodedText == input ? .exact : .decodedOnly
        )
    }

    nonisolated static func makeSegments(
        tokenIDs: [Int],
        decodedText: String,
        decode: ([Int]) -> String
    ) -> [TokenSegment] {
        guard !tokenIDs.isEmpty else { return [] }

        var segments: [TokenSegment] = []
        var start = 0
        while start < tokenIDs.count {
            var end = start + 1
            var text = decode(Array(tokenIDs[start..<end]))
            while end < tokenIDs.count && (text.isEmpty || text.contains("\u{FFFD}")) {
                end += 1
                text = decode(Array(tokenIDs[start..<end]))
            }
            segments.append(TokenSegment(
                tokenRange: start..<end,
                tokenIDs: Array(tokenIDs[start..<end]),
                text: text
            ))
            start = end
        }

        guard segments.map(\.text).joined() == decodedText else {
            return [TokenSegment(
                tokenRange: 0..<tokenIDs.count,
                tokenIDs: tokenIDs,
                text: decodedText
            )]
        }
        return segments
    }
}
