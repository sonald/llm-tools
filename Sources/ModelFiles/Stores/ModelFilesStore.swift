import AppKit
import Foundation

@MainActor
final class ModelFilesStore: ObservableObject {
    @Published var modelID = "Qwen/Qwen3-4B"
    @Published var sourceSelection: SourceSelection = .automatic
    @Published private(set) var snapshot: RepositorySnapshot?
    @Published var selectedPath: String?
    @Published var filter = ""
    @Published var detailMode: DetailMode = .summary
    @Published private(set) var isLoadingRepository = false
    @Published private(set) var loadingPath: String?
    @Published private(set) var errorMessage: String?

    private let service = RepositoryService()
    private var contents: [String: Data] = [:]
    private var repositoryTask: Task<Void, Never>?
    private var fileTask: Task<Void, Never>?

    var selectedFile: RemoteFile? {
        guard let selectedPath else { return nil }
        return snapshot?.files.first { $0.path == selectedPath }
    }

    var selectedData: Data? {
        guard let selectedPath else { return nil }
        return contents[selectedPath]
    }

    var statusText: String? {
        guard let snapshot else { return nil }
        let branch = snapshot.source == .modelScope ? "master" : "main"
        var components = [snapshot.source.title, branch]
        if let hash = selectedFile?.shortHash ?? (snapshot.revisionLabel.isEmpty ? nil : snapshot.revisionLabel) {
            components.append("SHA \(hash)")
        }
        return "已选择 " + components.joined(separator: " · ")
    }

    func files(in category: FileCategory) -> [RemoteFile] {
        guard let snapshot else { return [] }
        let term = filter.trimmingCharacters(in: .whitespacesAndNewlines)
        return snapshot.files.filter { file in
            file.category == category && (term.isEmpty || file.path.localizedCaseInsensitiveContains(term))
        }
    }

    func openModel() {
        repositoryTask?.cancel()
        fileTask?.cancel()
        isLoadingRepository = true
        errorMessage = nil
        snapshot = nil
        selectedPath = nil
        contents.removeAll()

        let requestedID = modelID
        let requestedSource = sourceSelection
        repositoryTask = Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await service.loadRepository(modelID: requestedID, selection: requestedSource)
                try Task.checkCancellation()
                self.snapshot = snapshot
                self.isLoadingRepository = false
                let preferred = snapshot.files.first { $0.path == "config.json" && !$0.isBlocked }
                    ?? snapshot.files.first { !$0.isBlocked }
                self.selectedPath = preferred?.path
                self.detailMode = .summary
                self.loadSelectedFile()
            } catch is CancellationError {
                self.isLoadingRepository = false
            } catch {
                self.isLoadingRepository = false
                self.errorMessage = error.localizedDescription
            }
        }
    }

    func select(path: String?) {
        guard selectedPath != path else { return }
        selectedPath = path
        detailMode = .summary
        errorMessage = nil
        loadSelectedFile()
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

        loadingPath = file.path
        fileTask = Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await service.loadFile(file, from: snapshot)
                try Task.checkCancellation()
                self.contents[file.path] = data
                self.loadingPath = nil
            } catch is CancellationError {
                self.loadingPath = nil
            } catch {
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

    func openSelectedOnSource() {
        guard let snapshot, let file = selectedFile,
              let url = service.sourceURL(for: file, snapshot: snapshot) else { return }
        NSWorkspace.shared.open(url)
    }
}
