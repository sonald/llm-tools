import Foundation
import Hub
import SentencepieceTokenizer
import Tokenizers

actor TokenizerRuntime {
    enum RuntimeError: LocalizedError {
        case invalidTokenizerData(String)
        case invalidSentencePieceModel(String)
        case invalidTokenizerConfig(String)
        case unsupported(String)

        var errorDescription: String? {
            switch self {
            case let .invalidTokenizerData(message):
                "tokenizer.json 无效：\(message)"
            case let .invalidSentencePieceModel(message):
                "SentencePiece model 无效：\(message)"
            case let .invalidTokenizerConfig(message):
                "tokenizer_config.json 无效：\(message)"
            case let .unsupported(message):
                "当前运行时无法加载该 tokenizer：\(message)"
            }
        }
    }

    private enum Backend {
        case huggingFace(any Tokenizer)
        case sentencePiece(SentencepieceTokenizer)
    }

    private let backend: Backend

    init(bundle: TokenizerBundle) throws {
        if bundle.file.isSentencePieceModel {
            let modelURL = FileManager.default.temporaryDirectory
                .appending(path: "ModelFiles-\(UUID().uuidString).model")
            defer { try? FileManager.default.removeItem(at: modelURL) }
            do {
                try bundle.tokenizerData.write(to: modelURL, options: .atomic)
                backend = .sentencePiece(try SentencepieceTokenizer(modelPath: modelURL.path, tokenOffset: 0))
            } catch {
                throw RuntimeError.invalidSentencePieceModel(error.localizedDescription)
            }
            return
        }

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
            backend = .huggingFace(try AutoTokenizer.from(
                tokenizerConfig: tokenizerConfig,
                tokenizerData: tokenizerData,
                strict: true
            ))
        } catch {
            throw RuntimeError.unsupported(error.localizedDescription)
        }
    }

    func tokenize(_ input: String) throws -> TokenizationResult {
        let tokenIDs: [Int]
        let tokenPieces: [String?]
        let decodedText: String
        let decode: ([Int]) throws -> String
        switch backend {
        case let .huggingFace(tokenizer):
            tokenIDs = tokenizer.encode(text: input, addSpecialTokens: false)
            tokenPieces = tokenizer.convertIdsToTokens(tokenIDs)
            decodedText = tokenizer.decode(tokens: tokenIDs, skipSpecialTokens: false)
            decode = { tokenizer.decode(tokens: $0, skipSpecialTokens: false) }
        case let .sentencePiece(tokenizer):
            tokenIDs = try tokenizer.encode(input)
            tokenPieces = try tokenIDs.map { try tokenizer.idToToken($0) }
            decodedText = try tokenizer.decode(tokenIDs)
            decode = tokenizer.decode
        }
        let segments = try Self.makeSegments(
            tokenIDs: tokenIDs,
            decodedText: decodedText,
            decode: decode
        )
        let reconstructed = segments.map(\.text).joined()
        return TokenizationResult(
            direction: .encode,
            input: input,
            tokenIDs: tokenIDs,
            tokenPieces: tokenPieces,
            decodedText: decodedText,
            segments: segments,
            sourceMapping: reconstructed == input && decodedText == input ? .exact : .decodedOnly,
            flags: Array(
                repeating: TokenFlags(isSpecial: false, specialName: nil),
                count: tokenIDs.count
            ),
            roles: nil,
            overhead: nil
        )
    }

    nonisolated static func makeSegments(
        tokenIDs: [Int],
        decodedText: String,
        decode: ([Int]) throws -> String
    ) throws -> [TokenSegment] {
        guard !tokenIDs.isEmpty else { return [] }

        var segments: [TokenSegment] = []
        var start = 0
        while start < tokenIDs.count {
            var end = start + 1
            var text = try decode(Array(tokenIDs[start..<end]))
            while end < tokenIDs.count && (text.isEmpty || text.contains("\u{FFFD}")) {
                end += 1
                text = try decode(Array(tokenIDs[start..<end]))
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
