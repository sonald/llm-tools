import Foundation

struct RepositoryService: Sendable {
    enum ServiceError: LocalizedError {
        case invalidModelID
        case invalidResponse
        case requestFailed(status: Int, message: String)
        case noSourceAvailable([String])
        case blockedWeight
        case fileTooLarge(Int64)
        case invalidSafetensorsHeader
        case safetensorsHeaderTooLarge(UInt64)

        var errorDescription: String? {
            switch self {
            case .invalidModelID:
                "模型 ID 无效，请使用类似 Qwen/Qwen3-4B 的格式。"
            case .invalidResponse:
                "源站返回了无法识别的数据。"
            case let .requestFailed(status, message):
                "请求失败（HTTP \(status)）：\(message)"
            case let .noSourceAvailable(messages):
                "两个源都不可用：\(messages.joined(separator: "；"))"
            case .blockedWeight:
                "该文件属于模型权重，应用不会下载它。"
            case let .fileTooLarge(size):
                "文件大小为 \(size.formattedByteCount)，超过 32 MB 阅读上限。"
            case .invalidSafetensorsHeader:
                "SafeTensors header 无效。"
            case let .safetensorsHeaderTooLarge(size):
                "SafeTensors header 为 \(size) 字节，超过安全上限。"
            }
        }
    }

    private enum LoadResult: Sendable {
        case success(RepositorySnapshot)
        case failure(String)
    }

    private let session: URLSession
    private let maximumReadableSize: Int64 = 32 * 1024 * 1024

    init(session: URLSession = .shared) {
        self.session = session
    }

    func loadRepository(modelID: String, selection: SourceSelection) async throws -> RepositorySnapshot {
        let normalized = try Self.normalizedModelID(from: modelID)

        switch selection {
        case .modelScope:
            return try await loadModelScope(modelID: normalized)
        case .huggingFace:
            return try await loadHuggingFace(modelID: normalized)
        case .automatic:
            return try await withThrowingTaskGroup(of: LoadResult.self) { group in
                group.addTask {
                    do { return .success(try await loadModelScope(modelID: normalized)) }
                    catch { return .failure("ModelScope: \(error.localizedDescription)") }
                }
                group.addTask {
                    do { return .success(try await loadHuggingFace(modelID: normalized)) }
                    catch { return .failure("Hugging Face: \(error.localizedDescription)") }
                }

                var failures: [String] = []
                while let result = try await group.next() {
                    switch result {
                    case let .success(snapshot):
                        group.cancelAll()
                        return snapshot
                    case let .failure(message):
                        failures.append(message)
                    }
                }
                throw ServiceError.noSourceAvailable(failures)
            }
        }
    }

    static func normalizedModelID(from input: String) throws -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed),
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            guard let host = url.host?.lowercased() else { throw ServiceError.invalidModelID }
            var components = url.pathComponents.filter { $0 != "/" }
            switch host {
            case "huggingface.co", "www.huggingface.co":
                break
            case "modelscope.cn", "www.modelscope.cn":
                guard components.first?.lowercased() == "models" else {
                    throw ServiceError.invalidModelID
                }
                components.removeFirst()
            default:
                throw ServiceError.invalidModelID
            }
            guard components.count >= 2 else { throw ServiceError.invalidModelID }
            return components.prefix(2).joined(separator: "/")
        }

        let components = trimmed.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count == 2, components.allSatisfy({ !$0.isEmpty }) else {
            throw ServiceError.invalidModelID
        }
        return trimmed
    }

    func loadFile(_ file: RemoteFile, from snapshot: RepositorySnapshot) async throws -> Data {
        if file.supportsMetadataPreview {
            return try await loadSafetensorsHeader(file, from: snapshot)
        }
        guard !file.isBlocked else { throw ServiceError.blockedWeight }
        if let size = file.size, size > maximumReadableSize {
            throw ServiceError.fileTooLarge(size)
        }

        let url = try contentURL(for: file, snapshot: snapshot)

        var request = URLRequest(url: url)
        request.timeoutInterval = 45
        request.setValue("ModelFiles/0.1 (macOS)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        guard data.count <= maximumReadableSize else {
            throw ServiceError.fileTooLarge(Int64(data.count))
        }
        return data
    }

    private func loadSafetensorsHeader(
        _ file: RemoteFile,
        from snapshot: RepositorySnapshot
    ) async throws -> Data {
        let url = try contentURL(for: file, snapshot: snapshot)
        let prefix = try await fetchRange(0...7, url: url)
        guard let headerLength = SafetensorsInspector.headerLength(from: prefix),
              headerLength > 1 else {
            throw ServiceError.invalidSafetensorsHeader
        }
        guard headerLength <= SafetensorsInspector.maximumHeaderLength else {
            throw ServiceError.safetensorsHeaderTooLarge(headerLength)
        }
        if let size = file.size, headerLength + 8 > UInt64(size) {
            throw ServiceError.invalidSafetensorsHeader
        }

        let end = 7 + headerLength
        let header = try await fetchRange(8...end, url: url)
        guard header.first == 0x7B,
              (try? JSONSerialization.jsonObject(with: header)) != nil else {
            throw ServiceError.invalidSafetensorsHeader
        }
        return header
    }

    private func fetchRange(_ range: ClosedRange<UInt64>, url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 45
        request.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range")
        request.setValue("ModelFiles/0.1 (macOS)", forHTTPHeaderField: "User-Agent")
        let length = range.upperBound - range.lowerBound + 1
        guard length <= UInt64(Int.max) else { throw ServiceError.invalidSafetensorsHeader }
        return try await HTTPRangeLoader.fetch(request, expectedCount: Int(length))
    }

    func contentURL(for file: RemoteFile, snapshot: RepositorySnapshot) throws -> URL {
        switch snapshot.source {
        case .huggingFace:
            return try makeURL("https://huggingface.co/\(encodedPath(snapshot.modelID))/resolve/\(encodedPath(file.revision))/\(encodedPath(file.path))")
        case .modelScope:
            return try makeURL("https://modelscope.cn/models/\(encodedPath(snapshot.modelID))/resolve/\(encodedPath(file.revision))/\(encodedPath(file.path))")
        }
    }

    func sourceURL(for file: RemoteFile, snapshot: RepositorySnapshot) -> URL? {
        let raw: String
        switch snapshot.source {
        case .huggingFace:
            raw = "https://huggingface.co/\(encodedPath(snapshot.modelID))/blob/\(encodedPath(file.revision))/\(encodedPath(file.path))"
        case .modelScope:
            raw = "https://modelscope.cn/models/\(encodedPath(snapshot.modelID))/file/\(encodedPath(file.revision))/\(encodedPath(file.path))"
        }
        return URL(string: raw)
    }

    private func loadHuggingFace(modelID: String) async throws -> RepositorySnapshot {
        let url = try makeURL("https://huggingface.co/api/models/\(encodedPath(modelID))?blobs=true")
        let (data, response) = try await session.data(from: url)
        try validate(response: response, data: data)
        let result = try JSONDecoder().decode(HuggingFaceResponse.self, from: data)
        let files = result.siblings.map { item in
            RemoteFile(
                path: item.rfilename,
                size: item.size ?? item.lfs?.size,
                isLFS: item.lfs != nil,
                revision: result.sha,
                contentHash: item.lfs?.sha256 ?? item.blobId,
                category: FileClassifier.category(for: item.rfilename)
            )
        }
        return RepositorySnapshot(
            modelID: modelID,
            source: .huggingFace,
            revision: result.sha,
            revisionLabel: String(result.sha.prefix(7)),
            files: files.sorted(by: fileSort)
        )
    }

    private func loadModelScope(modelID: String) async throws -> RepositorySnapshot {
        var components = URLComponents(string: "https://modelscope.cn/api/v1/models/\(encodedPath(modelID))/repo/files")
        components?.queryItems = [
            URLQueryItem(name: "Revision", value: "master"),
            URLQueryItem(name: "Recursive", value: "true")
        ]
        guard let url = components?.url else { throw ServiceError.invalidModelID }
        let (data, response) = try await session.data(from: url)
        try validate(response: response, data: data)
        let result = try JSONDecoder().decode(ModelScopeResponse.self, from: data)
        guard result.success, let payload = result.data else {
            throw ServiceError.requestFailed(status: result.code, message: result.message)
        }

        let revision = payload.files.first(where: { !$0.revision.isEmpty })?.revision ?? "master"
        let files = payload.files.compactMap { item -> RemoteFile? in
            guard item.type.lowercased() != "tree" else { return nil }
            return RemoteFile(
                path: item.path,
                size: item.size,
                isLFS: item.isLFS,
                revision: item.revision.isEmpty ? revision : item.revision,
                contentHash: item.sha256,
                category: FileClassifier.category(for: item.path)
            )
        }
        return RepositorySnapshot(
            modelID: modelID,
            source: .modelScope,
            revision: revision,
            revisionLabel: payload.latestCommitter?.shortId ?? String(revision.prefix(7)),
            files: files.sorted(by: fileSort)
        )
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw ServiceError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data.prefix(512), encoding: .utf8) ?? "未知错误"
            throw ServiceError.requestFailed(status: http.statusCode, message: message)
        }
    }

    private func makeURL(_ string: String) throws -> URL {
        guard let url = URL(string: string) else { throw ServiceError.invalidModelID }
        return url
    }

    private func encodedPath(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
    }

    private func fileSort(_ lhs: RemoteFile, _ rhs: RemoteFile) -> Bool {
        let categories = FileCategory.allCases
        let left = categories.firstIndex(of: lhs.category) ?? categories.endIndex
        let right = categories.firstIndex(of: rhs.category) ?? categories.endIndex
        guard left == right else { return left < right }
        let leftPriority = FileClassifier.sortPriority(for: lhs.path)
        let rightPriority = FileClassifier.sortPriority(for: rhs.path)
        return leftPriority == rightPriority
            ? lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
            : leftPriority < rightPriority
    }
}

private struct HuggingFaceResponse: Decodable {
    let sha: String
    let siblings: [HuggingFaceSibling]
}

private struct HuggingFaceSibling: Decodable {
    let rfilename: String
    let blobId: String?
    let size: Int64?
    let lfs: HuggingFaceLFS?
}

private struct HuggingFaceLFS: Decodable {
    let sha256: String?
    let size: Int64?
}

private struct ModelScopeResponse: Decodable {
    let code: Int
    let data: ModelScopeData?
    let message: String
    let success: Bool

    enum CodingKeys: String, CodingKey {
        case code = "Code"
        case data = "Data"
        case message = "Message"
        case success = "Success"
    }
}

private struct ModelScopeData: Decodable {
    let files: [ModelScopeFile]
    let latestCommitter: ModelScopeCommitter?

    enum CodingKeys: String, CodingKey {
        case files = "Files"
        case latestCommitter = "LatestCommitter"
    }
}

private struct ModelScopeFile: Decodable {
    let path: String
    let size: Int64?
    let isLFS: Bool
    let revision: String
    let sha256: String?
    let type: String

    enum CodingKeys: String, CodingKey {
        case path = "Path"
        case size = "Size"
        case isLFS = "IsLFS"
        case revision = "Revision"
        case sha256 = "Sha256"
        case type = "Type"
    }
}

private struct ModelScopeCommitter: Decodable {
    let shortId: String?

    enum CodingKeys: String, CodingKey {
        case shortId = "ShortId"
    }
}
