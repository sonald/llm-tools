import AppKit
import Foundation

@MainActor
final class ModelFilesStore: ObservableObject {
    @Published var repositoryInput = UserDefaults.standard.string(forKey: "ModelFiles.lastRepositoryInput")
        ?? UserDefaults.standard.string(forKey: "ModelFiles.lastModelID")
        ?? "Qwen/Qwen3-4B"
    @Published private(set) var repositoryHistory = ModelFilesStore.loadHistory(from: .standard)
    @Published private(set) var snapshot: RepositorySnapshot?
    @Published var selectedPath: String?
    @Published var filter = ""
    @Published var perspective: InspectionPerspective = .overview {
        didSet {
            if perspective == .playground {
                prepareTokenizerPlaygroundIfNeeded()
            }
        }
    }
    @Published private(set) var isLoadingRepository = false
    @Published private(set) var loadingPath: String?
    @Published private(set) var errorMessage: String?
    @Published private(set) var tokenizerPhase: TokenizerPlaygroundPhase = .idle
    @Published private(set) var tokenizationResult: TokenizationResult?
    @Published private(set) var tokenizerChatCatalog: ChatTemplateCatalog?
    @Published private(set) var tokenizerConfigData: Data?
    @Published private(set) var tokenizerClassOverride: String?
    @Published private(set) var consistencyReport: RepositoryConsistencyReport?

    private let service: RepositoryService
    private var contents: [String: InspectionDocument] = [:]
    private var repositoryTask: Task<Void, Never>?
    private var consistencyTask: Task<Void, Never>?
    private var fileTask: Task<Void, Never>?
    private var tokenizerLoadTask: Task<Void, Never>?
    private var tokenizerEncodeTask: Task<Void, Never>?
    private var tokenizerRuntime: TokenizerRuntime?
    private var tokenizerBundle: TokenizerBundle?
    private var tokenizerIdentity: TokenizerSessionIdentity?
    private var tokenizerLoadGeneration = 0
    private var tokenizerEncodeGeneration = 0
    private var consistencyGeneration = 0
    private var pendingTokenizerRequest: TokenizerEncodeRequest?

    static let maximumTokenizerInputByteCount = 64 * 1_024

    init(service: RepositoryService = RepositoryService()) {
        self.service = service
    }

    var selectedFile: RepositoryFile? {
        guard let selectedPath else { return nil }
        return snapshot?.files.first { $0.path == selectedPath }
    }

    var selectedInspection: InspectionDocument? {
        guard let selectedPath else { return nil }
        return contents[selectedPath]
    }

    var availablePerspectives: [InspectionPerspective] {
        guard let inspection = selectedInspection else { return [.overview] }
        if selectedFile?.isSentencePieceModel == true { return [.playground] }
        if selectedFile?.isTokenizerPlaygroundEntryPoint == true,
           !inspection.perspectives.contains(.playground) {
            return inspection.perspectives + [.playground]
        }
        return inspection.perspectives
    }

    var shouldOpenOnLaunch: Bool { !RepositoryService.isDirectoryInput(repositoryInput) }

    var statusText: String? {
        guard let snapshot else { return nil }
        var components = [snapshot.location.title]
        switch snapshot.version {
        case let .immutable(label):
            let branch = if case .modelScope = snapshot.location { "master" } else { "main" }
            components.append(branch)
            components.append("SHA \(selectedFile?.shortHash ?? label)")
        case .live:
            components.append("实时目录")
        }
        return components.joined(separator: " · ")
    }

    var hasMatchingFiles: Bool {
        FileCategory.allCases.contains { !files(in: $0).isEmpty }
    }

    func files(in category: FileCategory) -> [RepositoryFile] {
        guard let snapshot else { return [] }
        let term = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        return snapshot.files.filter { file in
            file.category == category && (term.isEmpty || file.path.localizedCaseInsensitiveContains(term))
        }
    }

    func openRepository() {
        repositoryTask?.cancel()
        consistencyTask?.cancel()
        consistencyGeneration += 1
        fileTask?.cancel()
        fileTask = nil
        isLoadingRepository = true
        errorMessage = nil
        snapshot = nil
        consistencyReport = nil
        selectedPath = nil
        loadingPath = nil
        contents.removeAll()
        resetTokenizerPlayground()

        let requestedInput = repositoryInput
        repositoryTask = Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await service.loadRepository(input: requestedInput)
                try Task.checkCancellation()
                let canonicalInput = snapshot.location.canonicalInput
                self.repositoryInput = canonicalInput
                self.snapshot = snapshot
                self.isLoadingRepository = false
                UserDefaults.standard.set(canonicalInput, forKey: "ModelFiles.lastRepositoryInput")
                let entry = RepositoryHistoryEntry(input: canonicalInput)
                self.repositoryHistory = Self.updatedHistory(self.repositoryHistory, with: entry)
                Self.saveHistory(self.repositoryHistory, to: .standard)
                let preferred = snapshot.files.first { $0.path == "config.json" && !$0.isBlocked }
                    ?? snapshot.files.first { !$0.isBlocked }
                self.selectedPath = preferred?.path
                self.perspective = preferred?.isSentencePieceModel == true ? .playground : .overview
                self.loadSelectedFile()
                let initialFileTask = self.fileTask
                guard self.snapshot?.location == snapshot.location,
                      self.snapshot?.version == snapshot.version,
                      self.snapshot?.files == snapshot.files else { return }
                self.startConsistencyTask(for: snapshot, waitingFor: initialFileTask)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.isLoadingRepository = false
                self.errorMessage = error.localizedDescription
            }
        }
    }

    func chooseLocalDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "选择模型目录"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        repositoryInput = url.path
    }

    func select(path: String?) {
        guard selectedPath != path else { return }
        selectedPath = path
        errorMessage = nil
        resetTokenizerPlayground()
        perspective = selectedFile?.isSentencePieceModel == true ? .playground : .overview
        loadSelectedFile()
    }

    func tokenize(_ input: String) {
        tokenize(TokenizerEncodeRequest(text: input))
    }

    func tokenize(_ request: TokenizerEncodeRequest) {
        pendingTokenizerRequest = request
        tokenizerEncodeTask?.cancel()
        tokenizerEncodeGeneration += 1
        let generation = tokenizerEncodeGeneration
        let input = request.text

        guard input.utf8.count <= Self.maximumTokenizerInputByteCount else {
            tokenizationResult = nil
            tokenizerPhase = .inputTooLarge(limit: Self.maximumTokenizerInputByteCount)
            return
        }
        guard let runtime = tokenizerRuntime else {
            tokenizationResult = nil
            prepareTokenizerPlaygroundIfNeeded()
            return
        }
        guard !input.isEmpty || request.chatAttribution != nil else {
            tokenizationResult = TokenizationResult(
                direction: .encode,
                input: "",
                tokenIDs: [],
                tokenPieces: [],
                decodedText: "",
                segments: [],
                sourceMapping: .exact,
                flags: [],
                roles: nil,
                overhead: nil
            )
            tokenizerPhase = .ready
            return
        }

        tokenizationResult = nil
        tokenizerPhase = .tokenizing
        tokenizerEncodeTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(225))
                try Task.checkCancellation()
                let result = try await runtime.tokenize(input)
                try Task.checkCancellation()
                let publishedResult: TokenizationResult
                if let attribution = request.chatAttribution {
                    let contentProbe = TokenAttributor.contentProbe(messages: attribution.messages)
                    let probeResult = try await runtime.tokenize(contentProbe)
                    try Task.checkCancellation()
                    let overhead = TokenAttributor.overhead(
                        rendered: input,
                        messages: attribution.messages
                    ) { candidate in
                        candidate == contentProbe ? probeResult.tokenCount : result.tokenCount
                    }
                    publishedResult = result.with(
                        overhead: overhead,
                        roles: TokenAttributor.roles(
                            rendered: input,
                            messages: attribution.messages,
                            result: result
                        )
                    )
                } else {
                    publishedResult = result
                }
                try Task.checkCancellation()
                guard let self,
                      generation == self.tokenizerEncodeGeneration,
                      request == self.pendingTokenizerRequest else { return }
                self.tokenizationResult = publishedResult
                self.tokenizerPhase = .ready
            } catch is CancellationError {
                return
            } catch {
                guard let self, generation == self.tokenizerEncodeGeneration else { return }
                self.tokenizerPhase = .failed(error.localizedDescription)
            }
        }
    }

    func decodeTokenIDs(_ raw: String) {
        pendingTokenizerRequest = nil
        tokenizerEncodeTask?.cancel()
        tokenizerEncodeGeneration += 1
        let generation = tokenizerEncodeGeneration

        let tokenIDs: [Int]
        do {
            tokenIDs = try TokenIDParser.parse(raw)
        } catch let error as TokenIDParser.ParseError {
            tokenizationResult = nil
            if case let .inputTooLarge(limit) = error {
                tokenizerPhase = .inputTooLarge(limit: limit)
            } else {
                tokenizerPhase = .failed(error.localizedDescription)
            }
            return
        } catch {
            tokenizationResult = nil
            tokenizerPhase = .failed(error.localizedDescription)
            return
        }

        guard let runtime = tokenizerRuntime else {
            tokenizationResult = nil
            prepareTokenizerPlaygroundIfNeeded()
            return
        }

        tokenizationResult = nil
        tokenizerPhase = .tokenizing
        tokenizerEncodeTask = Task { [weak self] in
            do {
                let result = try await runtime.decode(tokenIDs)
                try Task.checkCancellation()
                guard let self, generation == self.tokenizerEncodeGeneration else { return }
                self.tokenizationResult = result
                self.tokenizerPhase = .ready
            } catch is CancellationError {
                return
            } catch {
                guard let self, generation == self.tokenizerEncodeGeneration else { return }
                self.tokenizerPhase = .failed(error.localizedDescription)
            }
        }
    }

    func retryTokenizerPlayground() {
        tokenizerLoadTask?.cancel()
        tokenizerRuntime = nil
        tokenizerBundle = nil
        tokenizerIdentity = nil
        prepareTokenizerPlaygroundIfNeeded()
    }

    func setTokenizerClassOverride(_ name: String?) {
        let value = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        tokenizerClassOverride = value?.isEmpty == false ? value : nil
        guard let bundle = tokenizerBundle,
              let snapshot,
              let file = selectedFile,
              tokenizerChatCatalog != nil else {
            retryTokenizerPlayground()
            return
        }
        tokenizerLoadTask?.cancel()
        startTokenizerRuntimeConstruction(
            bundle: bundle,
            identity: TokenizerSessionIdentity(snapshot: snapshot, file: file),
            file: file
        )
    }

    func selectChatTemplate(id: String?) {
        guard let catalog = tokenizerChatCatalog else { return }
        tokenizerChatCatalog = catalog.selecting(id)
    }

    func clearTokenizationResult() {
        tokenizerEncodeTask?.cancel()
        tokenizerEncodeGeneration += 1
        pendingTokenizerRequest = nil
        tokenizationResult = nil
        if tokenizerRuntime != nil {
            tokenizerPhase = .ready
        }
    }

    private func prepareTokenizerPlaygroundIfNeeded() {
        guard perspective == .playground,
              let snapshot,
              let file = selectedFile,
              file.isTokenizerPlaygroundEntryPoint else { return }
        let identity = TokenizerSessionIdentity(snapshot: snapshot, file: file)
        if tokenizerIdentity == identity {
            if tokenizerRuntime != nil, let pendingTokenizerRequest {
                tokenize(pendingTokenizerRequest)
            }
            return
        }

        tokenizerLoadTask?.cancel()
        tokenizerEncodeTask?.cancel()
        tokenizerLoadGeneration += 1
        let generation = tokenizerLoadGeneration
        tokenizerRuntime = nil
        tokenizerBundle = nil
        tokenizerIdentity = nil
        tokenizationResult = nil
        tokenizerChatCatalog = nil
        tokenizerConfigData = nil
        tokenizerPhase = .loading

        tokenizerLoadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let bundle = try await service.loadTokenizerBundle(for: file, from: snapshot)
                try Task.checkCancellation()
                guard generation == self.tokenizerLoadGeneration,
                      self.selectedPath == file.path else { return }
                self.tokenizerBundle = bundle
                self.tokenizerIdentity = identity
                self.tokenizerConfigData = bundle.tokenizerConfigData
                self.tokenizerChatCatalog = try ChatTemplateCatalog.parse(
                    configData: bundle.tokenizerConfigData,
                    chatTemplateData: bundle.chatTemplateData
                )
                self.startTokenizerRuntimeConstruction(bundle: bundle, identity: identity, file: file)
            } catch is CancellationError {
                return
            } catch {
                guard generation == self.tokenizerLoadGeneration else { return }
                self.tokenizerRuntime = nil
                self.tokenizerPhase = .failed(error.localizedDescription)
            }
        }
    }

    private func startTokenizerRuntimeConstruction(
        bundle: TokenizerBundle,
        identity: TokenizerSessionIdentity,
        file: RepositoryFile
    ) {
        tokenizerEncodeTask?.cancel()
        tokenizerLoadGeneration += 1
        let generation = tokenizerLoadGeneration
        let tokenizerClassOverride = tokenizerClassOverride
        tokenizerRuntime = nil
        tokenizationResult = nil
        tokenizerPhase = .loading

        tokenizerLoadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let runtime = try await Task.detached(priority: .userInitiated) {
                    try TokenizerRuntime(
                        bundle: bundle,
                        tokenizerClassOverride: tokenizerClassOverride
                    )
                }.value
                try Task.checkCancellation()
                guard generation == self.tokenizerLoadGeneration,
                      self.selectedPath == file.path else { return }
                self.tokenizerRuntime = runtime
                self.tokenizerIdentity = identity
                self.tokenizerPhase = .ready
                if let request = self.pendingTokenizerRequest {
                    self.tokenize(request)
                }
            } catch is CancellationError {
                return
            } catch {
                guard generation == self.tokenizerLoadGeneration else { return }
                self.tokenizerRuntime = nil
                if case let TokenizerRuntime.RuntimeError.recoverableTokenizerClass(message) = error {
                    self.tokenizerPhase = .recoverableTokenizerClassFailure(message)
                } else {
                    self.tokenizerPhase = .failed(error.localizedDescription)
                }
            }
        }
    }

    private func resetTokenizerPlayground() {
        tokenizerLoadTask?.cancel()
        tokenizerEncodeTask?.cancel()
        tokenizerLoadGeneration += 1
        tokenizerEncodeGeneration += 1
        tokenizerRuntime = nil
        tokenizerBundle = nil
        tokenizerIdentity = nil
        tokenizerClassOverride = nil
        pendingTokenizerRequest = nil
        tokenizationResult = nil
        tokenizerChatCatalog = nil
        tokenizerConfigData = nil
        tokenizerPhase = .idle
    }

    private func startConsistencyTask(
        for snapshot: RepositorySnapshot,
        waitingFor initialFileTask: Task<Void, Never>? = nil
    ) {
        consistencyTask?.cancel()
        consistencyGeneration += 1
        let generation = consistencyGeneration
        consistencyTask = Task { [weak self] in
            guard let self else { return }
            do {
                if let initialFileTask {
                    await initialFileTask.value
                    try Task.checkCancellation()
                }
                let report = try await self.buildConsistencyReport(for: snapshot)
                try Task.checkCancellation()
                guard generation == self.consistencyGeneration,
                      self.snapshot?.location == snapshot.location,
                      self.snapshot?.version == snapshot.version,
                      self.snapshot?.files == snapshot.files else { return }
                self.consistencyReport = report
            } catch is CancellationError {
                return
            } catch {
                guard generation == self.consistencyGeneration,
                      self.snapshot?.location == snapshot.location,
                      self.snapshot?.version == snapshot.version,
                      self.snapshot?.files == snapshot.files else { return }
                self.consistencyReport = nil
            }
        }
    }

    private func buildConsistencyReport(
        for snapshot: RepositorySnapshot
    ) async throws -> RepositoryConsistencyReport {
        let configFile = consistencyFile(named: ["config.json", "configuration.json"], in: snapshot)
        let generationFile = consistencyFile(
            named: ["generation_config.json"],
            in: snapshot,
            relativeTo: configFile
        )
        let tokenizerConfigFile = consistencyFile(
            named: ["tokenizer_config.json"],
            in: snapshot,
            relativeTo: configFile
        )
        let tokenizerFile = consistencyFile(
            named: ["tokenizer.json"],
            in: snapshot,
            relativeTo: tokenizerConfigFile ?? configFile
        )
        let adapterFile = consistencyFile(named: ["adapter_config.json"], in: snapshot)
        let processorFile = consistencyFile(
            named: ["preprocessor_config.json", "processor_config.json"],
            in: snapshot
        )

        let config = try await readConsistencyData(configFile, from: snapshot)
        let generationConfig = try await readConsistencyData(generationFile, from: snapshot)
        let tokenizerConfig = try await readConsistencyData(tokenizerConfigFile, from: snapshot)
        let adapterConfig = try await readConsistencyData(adapterFile, from: snapshot)
        let processorConfig = try await readConsistencyData(processorFile, from: snapshot)

        let tokenizer: ConsistencyMaterial<TokenizerOverview>
        switch try await readConsistencyData(tokenizerFile, from: snapshot) {
        case .missing:
            tokenizer = .missing
        case let .failed(message):
            tokenizer = .failed(message)
        case let .skipped(reason):
            tokenizer = .skipped(reason)
        case let .available(data):
            let inspection = await Task.detached(priority: .userInitiated) {
                TokenizerInspector.inspect(data)
            }.value
            try Task.checkCancellation()
            if let overview = inspection.overview, inspection.error == nil {
                tokenizer = .available(overview)
            } else {
                tokenizer = .failed(inspection.error ?? "tokenizer.json 概览解析失败。")
            }
        }

        let jinjaFile = consistencyFile(
            named: ["chat_template.jinja"],
            in: snapshot,
            relativeTo: tokenizerConfigFile ?? tokenizerFile ?? configFile
        )
        let chatTemplates = try await chatTemplateMaterial(
            tokenizerConfig: tokenizerConfig,
            jinjaFile: jinjaFile,
            snapshot: snapshot
        )
        let gguf = consistencyGGUF(in: snapshot)
        return ConsistencyAnalyzer.analyze(materials: RepositoryConsistencyMaterials(
            config: config,
            generationConfig: generationConfig,
            tokenizerConfig: tokenizerConfig,
            tokenizer: tokenizer,
            adapterConfig: adapterConfig,
            processorConfig: processorConfig,
            chatTemplates: chatTemplates,
            gguf: gguf
        ))
    }

    private func readConsistencyData(
        _ file: RepositoryFile?,
        from snapshot: RepositorySnapshot
    ) async throws -> ConsistencyMaterial<Data> {
        guard let file else { return .missing }
        if let existing = contents[file.path] {
            switch existing {
            case let .generic(data): return .available(data)
            case let .jinja(document): return .available(Data(document.source.utf8))
            default: return .failed("\(file.path) 不是可读取的 JSON 文档。")
            }
        }
        do {
            let document = try await service.inspectFile(file, from: snapshot)
            contents[file.path] = document
            switch document {
            case let .generic(data): return .available(data)
            case let .jinja(document): return .available(Data(document.source.utf8))
            default: return .failed("\(file.path) 不是可读取的 JSON 文档。")
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    private func chatTemplateMaterial(
        tokenizerConfig: ConsistencyMaterial<Data>,
        jinjaFile: RepositoryFile?,
        snapshot: RepositorySnapshot
    ) async throws -> ConsistencyMaterial<ChatTemplateCatalog> {
        let jinja: ConsistencyMaterial<Data> = try await readConsistencyData(jinjaFile, from: snapshot)
        switch tokenizerConfig {
        case let .failed(message):
            if case let .available(data) = jinja {
                do {
                    return .available(try ChatTemplateCatalog.parse(
                        configData: nil,
                        chatTemplateData: data
                    ))
                } catch {
                    return .failed(error.localizedDescription)
                }
            }
            return .failed(message)
        case let .skipped(reason): return .skipped(reason)
        case .missing:
            switch jinja {
            case .missing: return .available(ChatTemplateCatalog(entries: []))
            case let .failed(message): return .failed(message)
            case let .skipped(reason): return .skipped(reason)
            case let .available(data):
                do { return .available(try ChatTemplateCatalog.parse(configData: nil, chatTemplateData: data)) }
                catch { return .failed(error.localizedDescription) }
            }
        case let .available(configData):
            switch jinja {
            case .missing:
                do {
                    return .available(try ChatTemplateCatalog.parse(
                        configData: configData,
                        chatTemplateData: nil
                    ))
                } catch {
                    return .failed(error.localizedDescription)
                }
            case let .available(jinjaData):
                do {
                    return .available(try ChatTemplateCatalog.parse(
                        configData: configData,
                        chatTemplateData: jinjaData
                    ))
                } catch {
                    return .failed(error.localizedDescription)
                }
            case let .failed(message):
                return .failed(message)
            case let .skipped(reason):
                return .skipped(reason)
            }
        }
    }

    private func consistencyGGUF(in snapshot: RepositorySnapshot) -> ConsistencyMaterial<GGUFOverview> {
        let files = snapshot.files.filter { $0.structuredInspectionFormat == .gguf }
        guard !files.isEmpty else { return .missing }
        for file in files.sorted(by: { $0.path < $1.path }) {
            if case let .gguf(overview, _) = contents[file.path] { return .available(overview) }
        }
        return .skipped("未在当前会话打开")
    }

    private func consistencyFile(
        named names: [String],
        in snapshot: RepositorySnapshot,
        relativeTo relativeFile: RepositoryFile? = nil
    ) -> RepositoryFile? {
        let names = Set(names.map { $0.lowercased() })
        let relativeDirectory = relativeFile.map {
            ($0.path as NSString).deletingLastPathComponent
        }
        return snapshot.files
            .filter { !$0.isBlocked && names.contains($0.name.lowercased()) }
            .sorted {
                let left = $0
                let right = $1
                let leftRoot = !left.path.contains("/")
                let rightRoot = !right.path.contains("/")
                if leftRoot != rightRoot { return leftRoot }
                if let relativeDirectory {
                    let leftSame = (left.path as NSString).deletingLastPathComponent == relativeDirectory
                    let rightSame = (right.path as NSString).deletingLastPathComponent == relativeDirectory
                    if leftSame != rightSame { return leftSame }
                }
                if left.path.count != right.path.count { return left.path.count < right.path.count }
                return left.path < right.path
            }
            .first
    }

    func loadSelectedFile() {
        fileTask?.cancel()
        guard let snapshot, let file = selectedFile, !file.isBlocked else {
            loadingPath = nil
            return
        }
        guard contents[file.path] == nil else {
            loadingPath = nil
            return
        }

        errorMessage = nil
        loadingPath = file.path
        fileTask = Task { [weak self] in
            guard let self else { return }
            do {
                let inspection = try await service.inspectFile(file, from: snapshot)
                try Task.checkCancellation()
                self.contents[file.path] = inspection
                self.loadingPath = nil
                if case .gguf = inspection {
                    self.startConsistencyTask(for: snapshot)
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.loadingPath = nil
                self.errorMessage = error.localizedDescription
            }
        }
    }

    func copySelectedPath() {
        guard let selectedPath else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(selectedPath, forType: .string)
    }

    func openSelectedExternally() {
        guard let snapshot, let file = selectedFile else { return }
        if case let .local(root) = snapshot.location {
            NSWorkspace.shared.activateFileViewerSelecting([root.appending(path: file.path)])
        } else if let url = service.browserURL(for: file, in: snapshot) {
            NSWorkspace.shared.open(url)
        }
    }

    nonisolated static func updatedHistory(
        _ history: [RepositoryHistoryEntry],
        with entry: RepositoryHistoryEntry
    ) -> [RepositoryHistoryEntry] {
        [entry] + history.filter { existing in
            if !RepositoryService.isDirectoryInput(entry.input),
               !RepositoryService.isDirectoryInput(existing.input) {
                return existing.input.caseInsensitiveCompare(entry.input) != .orderedSame
            }
            return existing.input != entry.input
        }
    }

    nonisolated static func loadHistory(from defaults: UserDefaults) -> [RepositoryHistoryEntry] {
        if let data = defaults.data(forKey: "ModelFiles.repositoryHistory.v2"),
           let history = try? JSONDecoder().decode([RepositoryHistoryEntry].self, from: data) {
            return history
        }
        return (defaults.stringArray(forKey: "ModelFiles.modelHistory") ?? []).map {
            RepositoryHistoryEntry(input: $0)
        }
    }

    nonisolated static func saveHistory(_ history: [RepositoryHistoryEntry], to defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(history) else { return }
        defaults.set(data, forKey: "ModelFiles.repositoryHistory.v2")
    }
}
