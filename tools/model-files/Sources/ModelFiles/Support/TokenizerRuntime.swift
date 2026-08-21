import Foundation
import Hub
import SentencepieceTokenizer
import Tokenizers

actor TokenizerRuntime {
    enum RuntimeError: LocalizedError {
        case invalidTokenizerData(String)
        case invalidSentencePieceModel(String)
        case invalidTokenizerConfig(String)
        case recoverableTokenizerClass(String)
        case unsupported(String)

        var errorDescription: String? {
            switch self {
            case let .invalidTokenizerData(message):
                String(localized: "tokenizer.json 无效：\(message)")
            case let .invalidSentencePieceModel(message):
                String(localized: "SentencePiece model 无效：\(message)")
            case let .invalidTokenizerConfig(message):
                String(localized: "tokenizer_config.json 无效：\(message)")
            case let .recoverableTokenizerClass(message):
                String(localized: "tokenizer_class 需要显式指定：\(message)")
            case let .unsupported(message):
                String(localized: "当前运行时无法加载该 tokenizer：\(message)")
            }
        }
    }

    private enum Backend {
        case huggingFace(any Tokenizer)
        case sentencePiece(SentencepieceTokenizer)
    }

    private let backend: Backend
    private let specialTokenIndex: SpecialTokenIndex
    private(set) var specialTokenDecodeFallbackCount = 0

    // Source: https://github.com/huggingface/swift-transformers/blob/2fa33e1f5e7131a7fc64c28e6d161dcec0d24820/Sources/Tokenizers/Tokenizer.swift#L158-L194
    nonisolated static let commonTokenizerClassOverrides = [
        "PreTrainedTokenizer",
        "PreTrainedTokenizerFast",
        "GPT2Tokenizer",
        "LlamaTokenizer",
    ]

    init(bundle: TokenizerBundle, tokenizerClassOverride: String? = nil) throws {
        let loadedBackend: Backend
        if bundle.file.isSentencePieceModel {
            let modelURL = FileManager.default.temporaryDirectory
                .appending(path: "ModelFiles-\(UUID().uuidString).model")
            defer { try? FileManager.default.removeItem(at: modelURL) }
            do {
                try bundle.tokenizerData.write(to: modelURL, options: .atomic)
                loadedBackend = .sentencePiece(
                    try SentencepieceTokenizer(modelPath: modelURL.path, tokenOffset: 0)
                )
            } catch {
                throw RuntimeError.invalidSentencePieceModel(error.localizedDescription)
            }
        } else {
            let tokenizerData: Config
            do {
                tokenizerData = try JSONDecoder().decode(Config.self, from: bundle.tokenizerData)
            } catch {
                throw RuntimeError.invalidTokenizerData(error.localizedDescription)
            }

            let tokenizerConfig: Config
            do {
                let configData = try Self.configData(
                    bundle.tokenizerConfigData,
                    tokenizerClassOverride: tokenizerClassOverride
                )
                tokenizerConfig = try configData.map {
                    try JSONDecoder().decode(Config.self, from: $0)
                } ?? Config([String: Config]())
            } catch let error as RuntimeError {
                throw error
            } catch {
                throw RuntimeError.invalidTokenizerConfig(error.localizedDescription)
            }

            do {
                loadedBackend = .huggingFace(try AutoTokenizer.from(
                    tokenizerConfig: tokenizerConfig,
                    tokenizerData: tokenizerData,
                    strict: true
                ))
            } catch let error as TokenizerError {
                // Source: https://github.com/huggingface/swift-transformers/blob/2fa33e1f5e7131a7fc64c28e6d161dcec0d24820/Sources/Tokenizers/Tokenizer.swift#L183-L199
                switch error {
                case .missingTokenizerClassInConfig where bundle.tokenizerConfigData != nil:
                    throw RuntimeError.recoverableTokenizerClass(error.localizedDescription)
                case .unsupportedTokenizer(_):
                    throw RuntimeError.recoverableTokenizerClass(error.localizedDescription)
                default:
                    throw RuntimeError.unsupported(error.localizedDescription)
                }
            } catch {
                throw RuntimeError.unsupported(error.localizedDescription)
            }
        }

        var index: SpecialTokenIndex
        do {
            index = try SpecialTokenIndex(
                tokenizerData: bundle.file.isSentencePieceModel ? nil : bundle.tokenizerData,
                tokenizerConfigData: bundle.tokenizerConfigData
            )
        } catch {
            throw bundle.file.isSentencePieceModel
                ? RuntimeError.invalidTokenizerConfig(error.localizedDescription)
                : RuntimeError.invalidTokenizerData(error.localizedDescription)
        }
        for piece in index.unresolvedPieces {
            guard let ids = try? Self.encode(piece, using: loadedBackend), ids.count == 1 else {
                continue
            }
            index.registerEncodedID(ids[0], for: piece)
        }
        backend = loadedBackend
        specialTokenIndex = index
    }

    private static func configData(
        _ data: Data?,
        tokenizerClassOverride: String?
    ) throws -> Data? {
        guard let tokenizerClass = tokenizerClassOverride?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !tokenizerClass.isEmpty else {
            return data
        }

        var object: [String: Any]
        if let data {
            guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw RuntimeError.invalidTokenizerConfig(String(localized: "根节点不是对象。"))
            }
            object = parsed
        } else {
            object = [:]
        }
        object["tokenizer_class"] = tokenizerClass
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
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
        return try makeResult(
            direction: .encode,
            input: input,
            tokenIDs: tokenIDs,
            tokenPieces: tokenPieces,
            decodedText: decodedText,
            decode: decode
        )
    }

    func decode(_ tokenIDs: [Int]) throws -> TokenizationResult {
        guard !tokenIDs.isEmpty else {
            return TokenizationResult(
                direction: .decode,
                input: "",
                tokenIDs: [],
                tokenPieces: [],
                decodedText: "",
                segments: [],
                sourceMapping: .decodedOnly,
                flags: [],
                roles: nil,
                overhead: nil
            )
        }

        let tokenPieces: [String?]
        let decodedText: String
        let decode: ([Int]) throws -> String
        switch backend {
        case let .huggingFace(tokenizer):
            tokenPieces = tokenizer.convertIdsToTokens(tokenIDs)
            decodedText = tokenizer.decode(tokens: tokenIDs, skipSpecialTokens: false)
            decode = { tokenizer.decode(tokens: $0, skipSpecialTokens: false) }
        case let .sentencePiece(tokenizer):
            tokenPieces = try tokenIDs.map { try tokenizer.idToToken($0) }
            decodedText = try tokenizer.decode(tokenIDs)
            decode = tokenizer.decode
        }
        return try makeResult(
            direction: .decode,
            input: tokenIDs.map(String.init).joined(separator: ", "),
            tokenIDs: tokenIDs,
            tokenPieces: tokenPieces,
            decodedText: decodedText,
            decode: decode
        )
    }

    private func makeResult(
        direction: TokenizationDirection,
        input: String,
        tokenIDs: [Int],
        tokenPieces: [String?],
        decodedText: String,
        decode: ([Int]) throws -> String
    ) throws -> TokenizationResult {
        let segments = try Self.makeSegments(
            tokenIDs: tokenIDs,
            decodedText: decodedText,
            decode: decode
        )
        let reconstructed = segments.map(\.text).joined()
        let sourceMapping: TokenizerSourceMapping = direction == .decode
            ? .decodedOnly
            : reconstructed == input && decodedText == input ? .exact : .decodedOnly
        return TokenizationResult(
            direction: direction,
            input: input,
            tokenIDs: tokenIDs,
            tokenPieces: tokenPieces,
            decodedText: decodedText,
            segments: segments,
            sourceMapping: sourceMapping,
            flags: try tokenFlags(for: tokenIDs, pieces: tokenPieces, decode: decode),
            roles: nil,
            overhead: nil
        )
    }

    private func tokenFlags(
        for tokenIDs: [Int],
        pieces: [String?],
        decode: ([Int]) throws -> String
    ) throws -> [TokenFlags] {
        try tokenIDs.enumerated().map { index, id in
            if specialTokenIndex.specialIDs.contains(id) {
                return TokenFlags(
                    isSpecial: true,
                    specialName: specialTokenIndex.specialNamesByID[id]
                )
            }

            let piece = pieces.indices.contains(index) ? pieces[index] : nil
            if let piece, !piece.isEmpty {
                return TokenFlags(
                    isSpecial: specialTokenIndex.specialPieces[piece] != nil,
                    specialName: specialTokenIndex.specialPieces[piece]
                )
            }

            specialTokenDecodeFallbackCount += 1
            let decoded = try decode([id])
            return TokenFlags(
                isSpecial: specialTokenIndex.specialPieces[decoded] != nil,
                specialName: specialTokenIndex.specialPieces[decoded]
            )
        }
    }

    private static func encode(_ input: String, using backend: Backend) throws -> [Int] {
        switch backend {
        case let .huggingFace(tokenizer):
            tokenizer.encode(text: input, addSpecialTokens: false)
        case let .sentencePiece(tokenizer):
            try tokenizer.encode(input)
        }
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
