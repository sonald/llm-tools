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
    @Published private(set) var tokenizerChatTemplate: String?
    @Published private(set) var tokenizerConfigData: Data?

    private let service: RepositoryService
    private var contents: [String: InspectionDocument] = [:]
    private var repositoryTask: Task<Void, Never>?
    private var fileTask: Task<Void, Never>?
    private var tokenizerLoadTask: Task<Void, Never>?
    private var tokenizerEncodeTask: Task<Void, Never>?
    private var tokenizerRuntime: TokenizerRuntime?
    private var tokenizerIdentity: TokenizerSessionIdentity?
    private var tokenizerLoadGeneration = 0
    private var tokenizerEncodeGeneration = 0
    private var pendingTokenizerInput: String?

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
        fileTask?.cancel()
        isLoadingRepository = true
        errorMessage = nil
        snapshot = nil
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
        pendingTokenizerInput = input
        tokenizerEncodeTask?.cancel()
        tokenizerEncodeGeneration += 1
        let generation = tokenizerEncodeGeneration

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
        guard !input.isEmpty else {
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
                guard let self,
                      generation == self.tokenizerEncodeGeneration,
                      input == self.pendingTokenizerInput else { return }
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
        tokenizerRuntime = nil
        tokenizerIdentity = nil
        prepareTokenizerPlaygroundIfNeeded()
    }

    func clearTokenizationResult() {
        tokenizerEncodeTask?.cancel()
        tokenizerEncodeGeneration += 1
        pendingTokenizerInput = nil
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
        if tokenizerRuntime != nil, tokenizerIdentity == identity {
            if let pendingTokenizerInput { tokenize(pendingTokenizerInput) }
            return
        }

        tokenizerLoadTask?.cancel()
        tokenizerEncodeTask?.cancel()
        tokenizerLoadGeneration += 1
        let generation = tokenizerLoadGeneration
        tokenizerRuntime = nil
        tokenizerIdentity = nil
        tokenizationResult = nil
        tokenizerChatTemplate = nil
        tokenizerConfigData = nil
        tokenizerPhase = .loading

        tokenizerLoadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let bundle = try await service.loadTokenizerBundle(for: file, from: snapshot)
                try Task.checkCancellation()
                let runtime = try await Task.detached(priority: .userInitiated) {
                    try TokenizerRuntime(bundle: bundle)
                }.value
                try Task.checkCancellation()
                guard generation == self.tokenizerLoadGeneration,
                      self.selectedPath == file.path else { return }
                self.tokenizerRuntime = runtime
                self.tokenizerIdentity = identity
                self.tokenizerConfigData = bundle.tokenizerConfigData
                self.tokenizerChatTemplate = try Self.chatTemplate(from: bundle)
                self.tokenizerPhase = .ready
                if let input = self.pendingTokenizerInput {
                    self.tokenize(input)
                }
            } catch is CancellationError {
                return
            } catch {
                guard generation == self.tokenizerLoadGeneration else { return }
                self.tokenizerRuntime = nil
                self.tokenizerIdentity = nil
                self.tokenizerPhase = .failed(error.localizedDescription)
            }
        }
    }

    private func resetTokenizerPlayground() {
        tokenizerLoadTask?.cancel()
        tokenizerEncodeTask?.cancel()
        tokenizerLoadGeneration += 1
        tokenizerEncodeGeneration += 1
        tokenizerRuntime = nil
        tokenizerIdentity = nil
        pendingTokenizerInput = nil
        tokenizationResult = nil
        tokenizerChatTemplate = nil
        tokenizerConfigData = nil
        tokenizerPhase = .idle
    }

    nonisolated private static func chatTemplate(from bundle: TokenizerBundle) throws -> String? {
        if let data = bundle.chatTemplateData {
            guard let source = String(data: data, encoding: .utf8) else {
                throw RepositoryService.ServiceError.invalidUTF8
            }
            if !source.isEmpty { return source }
        }
        guard let data = bundle.tokenizerConfigData,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let source = object["chat_template"] as? String,
              !source.isEmpty else { return nil }
        return source
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
