import Foundation

struct TokenizerBundle: Sendable {
    let file: RepositoryFile
    let tokenizerData: Data
    let tokenizerConfigData: Data?
    let chatTemplateData: Data?
}

struct TokenizerBundleLoader: Sendable {
    enum LoaderError: LocalizedError, Equatable {
        case invalidSelection(String)
        case missingSize(String)
        case fileTooLarge(path: String, size: Int64, limit: Int64)
        case bundleTooLarge(size: Int64, limit: Int64)

        var errorDescription: String? {
            switch self {
            case let .invalidSelection(path):
                String(localized: "只能为 tokenizer.json 或 SentencePiece .model 打开分词试验台：\(path)")
            case let .missingSize(path):
                String(localized: "来源没有提供 \(path) 的大小，无法在安全上限内读取。")
            case let .fileTooLarge(path, size, limit):
                String(localized: "\(path) 大小为 \(size.formattedByteCount)，超过分词器单文件上限 \(limit.formattedByteCount)。")
            case let .bundleTooLarge(size, limit):
                String(localized: "分词器资源合计 \(size.formattedByteCount)，超过 \(limit.formattedByteCount) 安全上限。")
            }
        }
    }

    static let maximumBundleByteCount: Int64 = 32 * 1_024 * 1_024

    private let maximumBundleByteCount: Int64

    init(maximumBundleByteCount: Int64 = Self.maximumBundleByteCount) {
        self.maximumBundleByteCount = maximumBundleByteCount
    }

    func load(
        file: RepositoryFile,
        from snapshot: RepositorySnapshot,
        access: any RepositoryAccess
    ) async throws -> TokenizerBundle {
        guard file.isTokenizerPlaygroundEntryPoint else {
            throw LoaderError.invalidSelection(file.path)
        }

        let directory = (file.path as NSString).deletingLastPathComponent
        let companion: (String) -> RepositoryFile? = { name in
            let path = directory.isEmpty || directory == "." ? name : "\(directory)/\(name)"
            return snapshot.files.first { $0.path == path && !$0.isBlocked }
        }
        let config = companion("tokenizer_config.json")
        let template = companion("chat_template.jinja")
        let files = [file, config, template].compactMap { $0 }

        let declaredTotal = try files.reduce(Int64(0)) { total, candidate in
            guard let size = candidate.size else { throw LoaderError.missingSize(candidate.path) }
            guard size <= maximumBundleByteCount else {
                throw LoaderError.fileTooLarge(
                    path: candidate.path,
                    size: size,
                    limit: maximumBundleByteCount
                )
            }
            let (sum, overflow) = total.addingReportingOverflow(size)
            guard !overflow, sum <= maximumBundleByteCount else {
                throw LoaderError.bundleTooLarge(size: overflow ? .max : sum, limit: maximumBundleByteCount)
            }
            return sum
        }
        guard declaredTotal <= maximumBundleByteCount else {
            throw LoaderError.bundleTooLarge(size: declaredTotal, limit: maximumBundleByteCount)
        }

        var actualTotal: Int64 = 0
        func read(_ candidate: RepositoryFile?) async throws -> Data? {
            guard let candidate else { return nil }
            try Task.checkCancellation()
            let data = try await access.read(candidate, range: nil)
            let (sum, overflow) = actualTotal.addingReportingOverflow(Int64(data.count))
            guard !overflow, sum <= maximumBundleByteCount else {
                throw LoaderError.bundleTooLarge(size: overflow ? .max : sum, limit: maximumBundleByteCount)
            }
            actualTotal = sum
            return data
        }

        guard let tokenizerData = try await read(file) else {
            throw LoaderError.invalidSelection(file.path)
        }
        return try await TokenizerBundle(
            file: file,
            tokenizerData: tokenizerData,
            tokenizerConfigData: read(config),
            chatTemplateData: read(template)
        )
    }
}
