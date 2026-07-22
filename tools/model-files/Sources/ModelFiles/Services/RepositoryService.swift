import Foundation

protocol RepositoryAccess: Sendable {
    var location: RepositoryLocation { get }

    func loadSnapshot() async throws -> RepositorySnapshot
    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data
}

struct RepositoryService: Sendable {
    enum ServiceError: LocalizedError {
        case invalidModelID
        case invalidLocalDirectory
        case invalidSSHLocation
        case directoryNotReadable
        case tooManyFiles(Int)
        case listingTooLarge
        case unsafePath(String)
        case fileChanged(String)
        case sshUnavailable
        case sshFailed(exitCode: Int32, message: String)
        case invalidResponse
        case requestFailed(status: Int, message: String)
        case noSourceAvailable([String])
        case blockedWeight
        case fileTooLarge(Int64)
        case invalidSafetensorsHeader
        case safetensorsHeaderTooLarge(UInt64)
        case invalidGGUF(String)
        case invalidIMatrix(String)
        case ggufMetadataTooLarge
        case missingFileSize
        case invalidUTF8
        case shortRead(expected: Int, actual: Int)

        var errorDescription: String? {
            switch self {
            case .invalidModelID:
                "模型 ID 无效，请使用类似 Qwen/Qwen3-4B 的格式。"
            case .invalidLocalDirectory:
                "本地模型目录无效或不可读取。"
            case .invalidSSHLocation:
                "SSH 地址无效，请使用 ssh://user@host/absolute/path。"
            case .directoryNotReadable:
                "模型目录不存在或不可读取。"
            case let .tooManyFiles(limit):
                "模型目录超过 \(limit.formatted()) 个文件，请选择更小的目录。"
            case .listingTooLarge:
                "SSH 文件清单超过 32 MB 安全上限，请选择更小的目录。"
            case let .unsafePath(path):
                "文件路径不安全，已拒绝读取：\(path)"
            case let .fileChanged(path):
                "文件已在清单生成后发生变化，请刷新目录：\(path)"
            case .sshUnavailable:
                "系统未提供 /usr/bin/ssh，无法打开 SSH 目录。"
            case let .sshFailed(exitCode, message):
                exitCode == 255
                    ? "SSH 连接失败：\(message)；请先在 Terminal 中确认该主机可以无交互登录。"
                    : "SSH 命令失败（退出码 \(exitCode)）：\(message)"
            case .invalidResponse:
                "来源返回了无法识别的数据。"
            case let .requestFailed(status, message):
                "请求失败（HTTP \(status)）：\(message)"
            case let .noSourceAvailable(messages):
                "两个源都不可用：\(messages.joined(separator: "；"))"
            case .blockedWeight:
                "该文件属于模型权重，应用不会读取它。"
            case let .fileTooLarge(size):
                "文件大小为 \(size.formattedByteCount)，超过 32 MB 阅读上限。"
            case .invalidSafetensorsHeader:
                "SafeTensors header 无效。"
            case let .safetensorsHeaderTooLarge(size):
                "SafeTensors header 为 \(size) 字节，超过安全上限。"
            case let .invalidGGUF(message):
                "GGUF 无效：\(message)"
            case let .invalidIMatrix(message):
                "Imatrix 无效：\(message)"
            case .ggufMetadataTooLarge:
                "GGUF metadata 与 tensor 目录超过 32 MB 安全上限。"
            case .missingFileSize:
                "来源未提供文件大小，无法安全读取 GGUF 前缀。"
            case .invalidUTF8:
                "文件不是有效的 UTF-8 文本。"
            case let .shortRead(expected, actual):
                "读取不完整：需要 \(expected) 字节，只收到 \(actual) 字节。"
            }
        }
    }

    private enum LoadResult: Sendable {
        case success(RepositorySnapshot)
        case failure(String)
    }

    private let session: URLSession
    private let accessOverride: (@Sendable (RepositoryLocation) -> any RepositoryAccess)?
    private let maximumReadableSize: Int64 = 32 * 1_024 * 1_024
    private let ggufChunkSize: UInt64 = 1 * 1_024 * 1_024

    init(session: URLSession = .shared) {
        self.session = session
        self.accessOverride = nil
    }

    init(makeAccess: @escaping @Sendable (RepositoryLocation) -> any RepositoryAccess) {
        self.session = .shared
        self.accessOverride = makeAccess
    }

    func loadRepository(input: String) async throws -> RepositorySnapshot {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if Self.isSSHInput(trimmed) {
            let location = try Self.normalizedSSHLocation(from: trimmed)
            return try await access(for: .ssh(location)).loadSnapshot()
        }
        if Self.isLocalInput(trimmed) {
            let root = try Self.normalizedLocalRoot(from: input)
            return try await access(for: .local(root: root)).loadSnapshot()
        }

        let modelID = try Self.normalizedModelID(from: input)
        let locations: [RepositoryLocation] = [
            .modelScope(modelID: modelID),
            .huggingFace(modelID: modelID),
        ]
        return try await withThrowingTaskGroup(of: LoadResult.self) { group in
            for location in locations {
                group.addTask {
                    do {
                        let access = try access(for: location)
                        return .success(try await access.loadSnapshot())
                    } catch {
                        return .failure("\(location.title): \(error.localizedDescription)")
                    }
                }
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

    static func isDirectoryInput(_ input: String) -> Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return isLocalInput(trimmed) || isSSHInput(trimmed)
    }

    private static func isLocalInput(_ input: String) -> Bool {
        input.hasPrefix("/") || input.lowercased().hasPrefix("file://")
    }

    private static func isSSHInput(_ input: String) -> Bool {
        input.lowercased().hasPrefix("ssh://")
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

    static func normalizedLocalRoot(from input: String) throws -> URL {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let url: URL
        if let parsed = URL(string: trimmed), parsed.isFileURL, parsed.path.hasPrefix("/") {
            url = parsed
        } else {
            guard trimmed.hasPrefix("/") else { throw ServiceError.invalidLocalDirectory }
            url = URL(fileURLWithPath: trimmed, isDirectory: true)
        }
        return url.standardizedFileURL.resolvingSymlinksInPath()
    }

    static func normalizedSSHLocation(from input: String) throws -> SSHLocation {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "ssh",
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              let host = components.host,
              !host.isEmpty,
              !host.hasPrefix("-"),
              components.port.map({ (1...65_535).contains($0) }) ?? true else {
            throw ServiceError.invalidSSHLocation
        }

        let hostCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-:"))
        let userCharacters = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        guard host.unicodeScalars.allSatisfy(hostCharacters.contains),
              components.user.map({ $0.unicodeScalars.allSatisfy(userCharacters.contains) }) ?? true else {
            throw ServiceError.invalidSSHLocation
        }

        let rootPath = components.path
        guard rootPath.hasPrefix("/"),
              rootPath != "/~",
              !rootPath.hasPrefix("/~/"),
              !rootPath.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw ServiceError.invalidSSHLocation
        }
        return SSHLocation(user: components.user, host: host, port: components.port, rootPath: rootPath)
    }

    func inspectFile(_ file: RepositoryFile, from snapshot: RepositorySnapshot) async throws -> InspectionDocument {
        let access = try access(for: snapshot.location)
        switch file.structuredInspectionFormat {
        case .safetensors:
            let header = try await loadSafetensorsHeader(file, access: access)
            let inspection = SafetensorsInspector.inspect(header)
            guard let overview = inspection.overview else {
                throw ServiceError.invalidSafetensorsHeader
            }
            return .safetensors(overview, headerByteCount: header.count)
        case .gguf:
            let (overview, downloadedByteCount) = try await loadGGUF(file, access: access)
            return .gguf(overview, downloadedByteCount: downloadedByteCount)
        case .imatrix:
            let data = try await loadReadableFile(file, access: access)
            let inspection = IMatrixInspector.inspect(data)
            guard let overview = inspection.overview else {
                throw ServiceError.invalidIMatrix(inspection.error ?? "无法解析 legacy imatrix 文件。")
            }
            return .imatrix(overview)
        case .jinja:
            let data = try await loadReadableFile(file, access: access)
            guard let source = String(data: data, encoding: .utf8) else {
                throw ServiceError.invalidUTF8
            }
            return .jinja(JinjaDocument(source: source))
        case nil:
            guard !file.isBlocked else { throw ServiceError.blockedWeight }
            return .generic(try await loadReadableFile(file, access: access))
        }
    }

    func browserURL(for file: RepositoryFile, in snapshot: RepositorySnapshot) -> URL? {
        guard let access = try? hubAccess(for: snapshot.location) else { return nil }
        return access.browserURL(for: file)
    }

    func markdownBaseURL(for file: RepositoryFile, in snapshot: RepositorySnapshot) -> URL? {
        guard let access = try? hubAccess(for: snapshot.location),
              let url = try? access.contentURL(for: file) else { return nil }
        return url.deletingLastPathComponent()
    }

    private func loadReadableFile(
        _ file: RepositoryFile,
        access: any RepositoryAccess
    ) async throws -> Data {
        if let size = file.size, size > maximumReadableSize {
            throw ServiceError.fileTooLarge(size)
        }

        let data = try await access.read(file, range: nil)
        guard data.count <= maximumReadableSize else {
            throw ServiceError.fileTooLarge(Int64(data.count))
        }
        return data
    }

    private func loadGGUF(
        _ file: RepositoryFile,
        access: any RepositoryAccess
    ) async throws -> (GGUFOverview, Int) {
        guard let fileSize = file.size, fileSize > 0 else {
            throw ServiceError.missingFileSize
        }
        let budget = min(UInt64(fileSize), UInt64(maximumReadableSize))
        var data = Data()
        var start: UInt64 = 0

        while start < budget {
            try Task.checkCancellation()
            let end = min(start + ggufChunkSize, budget) - 1
            data.append(try await readExact(file, range: start...end, access: access))

            switch GGUFInspector.inspect(data) {
            case let .complete(overview):
                return (overview, data.count)
            case .needsMoreData:
                start = end + 1
            case let .invalid(message):
                throw ServiceError.invalidGGUF(message)
            }
        }

        if UInt64(fileSize) <= budget {
            throw ServiceError.invalidGGUF("文件在 metadata 与 tensor 目录完成前结束。")
        }
        throw ServiceError.ggufMetadataTooLarge
    }

    private func loadSafetensorsHeader(
        _ file: RepositoryFile,
        access: any RepositoryAccess
    ) async throws -> Data {
        let prefix = try await readExact(file, range: 0...7, access: access)
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

        let header = try await readExact(file, range: 8...(7 + headerLength), access: access)
        guard header.first == 0x7B,
              (try? JSONSerialization.jsonObject(with: header)) != nil else {
            throw ServiceError.invalidSafetensorsHeader
        }
        return header
    }

    private func readExact(
        _ file: RepositoryFile,
        range: ClosedRange<UInt64>,
        access: any RepositoryAccess
    ) async throws -> Data {
        let length = range.upperBound - range.lowerBound + 1
        guard length <= UInt64(Int.max) else { throw ServiceError.invalidResponse }
        let data = try await access.read(file, range: range)
        guard data.count == Int(length) else {
            throw ServiceError.shortRead(expected: Int(length), actual: data.count)
        }
        return data
    }

    private func access(for location: RepositoryLocation) throws -> any RepositoryAccess {
        if let accessOverride { return accessOverride(location) }
        switch location {
        case .modelScope, .huggingFace:
            return try hubAccess(for: location)
        case .local:
            return LocalDirectoryAccess(location: location)
        case .ssh:
            return SSHDirectoryAccess(location: location)
        }
    }

    private func hubAccess(for location: RepositoryLocation) throws -> HubRepositoryAccess {
        switch location {
        case .modelScope, .huggingFace:
            HubRepositoryAccess(location: location, session: session)
        case .local, .ssh:
            throw ServiceError.invalidResponse
        }
    }
}

private struct HubRepositoryAccess: RepositoryAccess {
    let location: RepositoryLocation
    let session: URLSession

    func loadSnapshot() async throws -> RepositorySnapshot {
        switch location {
        case let .huggingFace(modelID):
            return try await loadHuggingFace(modelID: modelID)
        case let .modelScope(modelID):
            return try await loadModelScope(modelID: modelID)
        case .local, .ssh:
            throw RepositoryService.ServiceError.invalidResponse
        }
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        let url = try contentURL(for: file)
        var request = URLRequest(url: url)
        request.timeoutInterval = 45
        request.setValue("ModelFiles/0.1 (macOS)", forHTTPHeaderField: "User-Agent")

        if let range {
            let length = range.upperBound - range.lowerBound + 1
            guard length <= UInt64(Int.max) else {
                throw RepositoryService.ServiceError.invalidResponse
            }
            request.setValue("bytes=\(range.lowerBound)-\(range.upperBound)", forHTTPHeaderField: "Range")
            return try await HTTPRangeLoader.fetch(request, expectedCount: Int(length))
        }

        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return data
    }

    func contentURL(for file: RepositoryFile) throws -> URL {
        guard let revision = file.revision, !revision.isEmpty else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        switch location {
        case let .huggingFace(modelID):
            return try makeURL("https://huggingface.co/\(encodedPath(modelID))/resolve/\(encodedPath(revision))/\(encodedPath(file.path))")
        case let .modelScope(modelID):
            return try makeURL("https://modelscope.cn/models/\(encodedPath(modelID))/resolve/\(encodedPath(revision))/\(encodedPath(file.path))")
        case .local, .ssh:
            throw RepositoryService.ServiceError.invalidResponse
        }
    }

    func browserURL(for file: RepositoryFile) -> URL? {
        guard let revision = file.revision, !revision.isEmpty else { return nil }
        let raw: String
        switch location {
        case let .huggingFace(modelID):
            raw = "https://huggingface.co/\(encodedPath(modelID))/blob/\(encodedPath(revision))/\(encodedPath(file.path))"
        case let .modelScope(modelID):
            raw = "https://modelscope.cn/models/\(encodedPath(modelID))/file/\(encodedPath(revision))/\(encodedPath(file.path))"
        case .local, .ssh:
            return nil
        }
        return URL(string: raw)
    }

    private func loadHuggingFace(modelID: String) async throws -> RepositorySnapshot {
        let url = try makeURL("https://huggingface.co/api/models/\(encodedPath(modelID))?blobs=true")
        let (data, response) = try await session.data(from: url)
        try validate(response: response, data: data)
        let result = try JSONDecoder().decode(HuggingFaceResponse.self, from: data)
        let files = result.siblings.map { item in
            RepositoryFile(
                path: item.rfilename,
                size: item.size ?? item.lfs?.size,
                revision: result.sha,
                contentHash: item.lfs?.sha256 ?? item.blobId,
                category: FileClassifier.category(for: item.rfilename)
            )
        }
        return RepositorySnapshot(
            location: location,
            version: .immutable(label: String(result.sha.prefix(7))),
            files: files.sorted(by: RepositoryFile.displayOrder)
        )
    }

    private func loadModelScope(modelID: String) async throws -> RepositorySnapshot {
        var components = URLComponents(string: "https://modelscope.cn/api/v1/models/\(encodedPath(modelID))/repo/files")
        components?.queryItems = [
            URLQueryItem(name: "Revision", value: "master"),
            URLQueryItem(name: "Recursive", value: "true"),
        ]
        guard let url = components?.url else {
            throw RepositoryService.ServiceError.invalidModelID
        }
        let (data, response) = try await session.data(from: url)
        try validate(response: response, data: data)
        let result = try JSONDecoder().decode(ModelScopeResponse.self, from: data)
        guard result.success, let payload = result.data else {
            throw RepositoryService.ServiceError.requestFailed(status: result.code, message: result.message)
        }

        let revision = payload.files.first(where: { !$0.revision.isEmpty })?.revision ?? "master"
        let files = payload.files.compactMap { item -> RepositoryFile? in
            guard item.type.lowercased() != "tree" else { return nil }
            return RepositoryFile(
                path: item.path,
                size: item.size,
                revision: item.revision.isEmpty ? revision : item.revision,
                contentHash: item.sha256,
                category: FileClassifier.category(for: item.path)
            )
        }
        return RepositorySnapshot(
            location: location,
            version: .immutable(label: payload.latestCommitter?.shortId ?? String(revision.prefix(7))),
            files: files.sorted(by: RepositoryFile.displayOrder)
        )
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data.prefix(512), encoding: .utf8) ?? "未知错误"
            throw RepositoryService.ServiceError.requestFailed(status: http.statusCode, message: message)
        }
    }

    private func makeURL(_ string: String) throws -> URL {
        guard let url = URL(string: string) else {
            throw RepositoryService.ServiceError.invalidModelID
        }
        return url
    }

    private func encodedPath(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
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
    let revision: String
    let sha256: String?
    let type: String

    enum CodingKeys: String, CodingKey {
        case path = "Path"
        case size = "Size"
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
