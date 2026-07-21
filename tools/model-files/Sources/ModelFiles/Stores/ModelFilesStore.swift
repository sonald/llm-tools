import AppKit
import Foundation

@MainActor
final class ModelFilesStore: ObservableObject {
    @Published var modelID = UserDefaults.standard.string(forKey: "ModelFiles.lastModelID") ?? "Qwen/Qwen3-4B"
    @Published var sourceSelection = SourceSelection(
        rawValue: UserDefaults.standard.string(forKey: "ModelFiles.sourceSelection") ?? ""
    ) ?? .automatic
    @Published private(set) var modelHistory =
        UserDefaults.standard.stringArray(forKey: "ModelFiles.modelHistory") ?? []
    @Published private(set) var snapshot: RepositorySnapshot?
    @Published var selectedPath: String?
    @Published var filter = ""
    @Published var perspective: InspectionPerspective = .overview
    @Published private(set) var isLoadingRepository = false
    @Published private(set) var loadingPath: String?
    @Published private(set) var errorMessage: String?

    private let service = RepositoryService()
    private var contents: [String: InspectionDocument] = [:]
    private var repositoryTask: Task<Void, Never>?
    private var fileTask: Task<Void, Never>?

    var selectedFile: RemoteFile? {
        guard let selectedPath else { return nil }
        return snapshot?.files.first { $0.path == selectedPath }
    }

    var selectedInspection: InspectionDocument? {
        guard let selectedPath else { return nil }
        return contents[selectedPath]
    }

    var availablePerspectives: [InspectionPerspective] {
        selectedInspection?.perspectives ?? [.overview]
    }

    var statusText: String? {
        guard let snapshot else { return nil }
        let branch = snapshot.source == .modelScope ? "master" : "main"
        var components = [snapshot.source.title, branch]
        if let hash = selectedFile?.shortHash ?? (snapshot.revisionLabel.isEmpty ? nil : snapshot.revisionLabel) {
            components.append("SHA \(hash)")
        }
        return components.joined(separator: " · ")
    }

    var hasMatchingFiles: Bool {
        FileCategory.allCases.contains { !files(in: $0).isEmpty }
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
        loadingPath = nil
        contents.removeAll()

        let requestedID = modelID
        let requestedSource = sourceSelection
        repositoryTask = Task { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try await service.loadRepository(modelID: requestedID, selection: requestedSource)
                try Task.checkCancellation()
                self.modelID = snapshot.modelID
                self.snapshot = snapshot
                self.isLoadingRepository = false
                UserDefaults.standard.set(snapshot.modelID, forKey: "ModelFiles.lastModelID")
                UserDefaults.standard.set(requestedSource.rawValue, forKey: "ModelFiles.sourceSelection")
                self.modelHistory = Self.updatedHistory(self.modelHistory, with: snapshot.modelID)
                UserDefaults.standard.set(self.modelHistory, forKey: "ModelFiles.modelHistory")
                let preferred = snapshot.files.first { $0.path == "config.json" && !$0.isBlocked }
                    ?? snapshot.files.first { !$0.isBlocked }
                self.selectedPath = preferred?.path
                self.perspective = .overview
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

    func select(path: String?) {
        guard selectedPath != path else { return }
        selectedPath = path
        perspective = .overview
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

    func openSelectedOnSource() {
        guard let snapshot, let file = selectedFile,
              let url = service.sourceURL(for: file, snapshot: snapshot) else { return }
        NSWorkspace.shared.open(url)
    }

    nonisolated static func updatedHistory(_ history: [String], with modelID: String) -> [String] {
        [modelID] + history.filter { $0.caseInsensitiveCompare(modelID) != .orderedSame }
    }
}
