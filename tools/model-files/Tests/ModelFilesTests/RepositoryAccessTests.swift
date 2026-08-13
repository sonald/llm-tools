import Foundation
import XCTest
@testable import ModelFiles

final class RepositoryAccessTests: XCTestCase {
    func testLocalDirectoryListsFilesAndReadsExactRanges() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let nested = root.appending(path: "nested folder")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try Data("config".utf8).write(to: root.appending(path: "config.json"))
        try Data("hidden".utf8).write(to: root.appending(path: ".gitattributes"))
        try Data("0123456789".utf8).write(to: nested.appending(path: "数据.txt"))
        try FileManager.default.createSymbolicLink(
            at: root.appending(path: "config-link.json"),
            withDestinationURL: root.appending(path: "config.json")
        )

        let service = RepositoryService()
        let snapshot = try await service.loadRepository(input: root.path)

        guard case let .local(snapshotRoot) = snapshot.location else {
            return XCTFail("Expected local location")
        }
        XCTAssertTrue(snapshotRoot.path.hasSuffix(root.lastPathComponent))
        XCTAssertEqual(snapshot.version, .live)
        XCTAssertEqual(
            Set(snapshot.files.map(\.path)),
            ["config.json", ".gitattributes", "nested folder/数据.txt"]
        )

        let file = try XCTUnwrap(snapshot.files.first { $0.path == "nested folder/数据.txt" })
        let access = LocalDirectoryAccess(location: snapshot.location)
        let range = try await access.read(file, range: 2...5)
        XCTAssertEqual(range, Data("2345".utf8))

        let symlink = RepositoryFile(
            path: "config-link.json",
            size: 6,
            revision: nil,
            contentHash: nil,
            category: .configuration
        )
        do {
            _ = try await access.read(symlink, range: nil)
            XCTFail("Expected symlink to be rejected")
        } catch let error as RepositoryService.ServiceError {
            guard case .unsafePath = error else { return XCTFail("Unexpected error: \(error)") }
        }
    }

    func testLocalDirectoryRejectsEscapesAndChangedFiles() async throws {
        let root = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "config.json")
        try Data("one".utf8).write(to: url)

        do {
            try validateRepositoryRelativePath("../config.json")
            XCTFail("Expected unsafePath")
        } catch {
            XCTAssertTrue(error is RepositoryService.ServiceError)
        }

        let access = LocalDirectoryAccess(location: .local(root: root))
        let snapshot = try await access.loadSnapshot()
        let file = try XCTUnwrap(snapshot.files.first)
        try Data("changed".utf8).write(to: url)

        do {
            _ = try await access.read(file, range: nil)
            XCTFail("Expected fileChanged")
        } catch let error as RepositoryService.ServiceError {
            guard case .fileChanged("config.json") = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testNormalizesSSHLocationsAndRejectsCredentialsInURLs() throws {
        let location = try RepositoryService.normalizedSSHLocation(
            from: "ssh://alice@gpu.example.com:2222/srv/models/My%20Model"
        )

        XCTAssertEqual(location.user, "alice")
        XCTAssertEqual(location.host, "gpu.example.com")
        XCTAssertEqual(location.port, 2222)
        XCTAssertEqual(location.rootPath, "/srv/models/My Model")
        XCTAssertEqual(location.canonicalInput, "ssh://alice@gpu.example.com:2222/srv/models/My%20Model")

        for invalid in [
            "ssh://alice:secret@gpu.example.com/srv/model",
            "ssh://-oProxyCommand=bad/srv/model",
            "ssh://gpu.example.com/~/model",
            "ssh://gpu.example.com",
        ] {
            XCTAssertThrowsError(try RepositoryService.normalizedSSHLocation(from: invalid), invalid)
        }
    }

    func testInfersRepositorySourceFromInput() async throws {
        let service = RepositoryService(makeAccess: { EchoRepositoryAccess(location: $0) })

        let local = try await service.loadRepository(input: "/tmp/models/Qwen")
        guard case .local = local.location else { return XCTFail("Expected local location") }

        let ssh = try await service.loadRepository(input: "ssh://alice@gpu.example.com/srv/models/Qwen")
        guard case .ssh = ssh.location else { return XCTFail("Expected SSH location") }

        let hub = try await service.loadRepository(input: "Qwen/Qwen3-4B")
        switch hub.location {
        case .modelScope, .huggingFace:
            break
        case .local, .ssh:
            XCTFail("Expected automatic Hub location")
        }

        XCTAssertTrue(RepositoryService.isDirectoryInput("file:///tmp/models/Qwen"))
        XCTAssertTrue(RepositoryService.isDirectoryInput("ssh://gpu/srv/models/Qwen"))
        XCTAssertFalse(RepositoryService.isDirectoryInput("Qwen/Qwen3-4B"))
    }

    func testParsesNULTerminatedSSHListingsAndQuotesPaths() throws {
        var listing = Data()
        for field in ["config.json", "6", "nested/odd\n'name.txt", "2"] {
            listing.append(Data(field.utf8))
            listing.append(0)
        }

        let files = try SSHDirectoryAccess.parseListing(listing)

        XCTAssertEqual(Set(files.map(\.path)), ["config.json", "nested/odd\n'name.txt"])
        XCTAssertEqual(SSHDirectoryAccess.shellQuote("a'b"), "'a'\\''b'")
        XCTAssertThrowsError(try SSHDirectoryAccess.parseListing(Data("missing terminator".utf8)))
    }

    func testComputesAlignedSSHReadWindows() throws {
        XCTAssertEqual(
            try SSHDirectoryAccess.readWindow(offset: 65_535, length: 2),
            SSHReadWindow(skipBlocks: 0, blockCount: 2, prefixByteCount: 65_535, stdoutLimit: 131_072)
        )
        XCTAssertEqual(
            try SSHDirectoryAccess.readWindow(offset: 65_536, length: 65_536),
            SSHReadWindow(skipBlocks: 1, blockCount: 1, prefixByteCount: 0, stdoutLimit: 65_536)
        )
    }

    func testSSHProcessRunnerSeparatesStandardError() async throws {
        let runner = SSHProcessRunner(executableURL: URL(fileURLWithPath: "/bin/sh"))
        let output = try await runner.run(
            arguments: ["-c", "printf abc; printf warning >&2"],
            standardInput: Data(),
            stdoutLimit: 3
        )

        XCTAssertEqual(output.exitCode, 0)
        XCTAssertEqual(output.stdout, Data("abc".utf8))
        XCTAssertEqual(output.stderr, Data("warning".utf8))
        XCTAssertFalse(output.stderrWasTruncated)
    }

    func testSSHProcessRunnerStopsOnTaskCancellation() async throws {
        let runner = SSHProcessRunner(executableURL: URL(fileURLWithPath: "/bin/sh"))
        let task = Task {
            try await runner.run(
                arguments: ["-c", "while :; do :; done"],
                standardInput: Data(),
                stdoutLimit: 0
            )
        }
        try await Task.sleep(for: .milliseconds(30))
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
            // Expected.
        }
    }

    func testSSHDirectoryRunsListingAndRangeScriptsThroughFakeSSH() async throws {
        let temporary = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: temporary) }
        let root = temporary.appending(path: "model 'one", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("0123456789".utf8).write(to: root.appending(path: "config.json"))

        let executable = temporary.appending(path: "fake-ssh")
        let script = """
        #!/bin/sh
        while [ "$#" -gt 0 ]; do
          case "$1" in
            -T) shift ;;
            -o|-p|-l) shift 2 ;;
            *) break ;;
          esac
        done
        shift
        exec /bin/sh -c "$*"
        """
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)

        let location = RepositoryLocation.ssh(SSHLocation(
            user: nil,
            host: "fake",
            port: nil,
            rootPath: root.path
        ))
        let access = SSHDirectoryAccess(
            location: location,
            runner: SSHProcessRunner(executableURL: executable)
        )
        let snapshot = try await access.loadSnapshot()
        let file = try XCTUnwrap(snapshot.files.first { $0.path == "config.json" })
        let data = try await access.read(file, range: 3...6)

        XCTAssertEqual(data, Data("3456".utf8))
        XCTAssertEqual(snapshot.version, .live)
    }

    func testServiceRequestsOnlySafetensorsHeaderAndNeverReadsBlockedWeights() async throws {
        let header = Data(#"{"weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#.utf8)
        var headerLength = UInt64(header.count).littleEndian
        var bytes = withUnsafeBytes(of: &headerLength) { Data($0) }
        bytes.append(header)
        bytes.append(contentsOf: [0, 0, 0, 0])
        let access = RecordingRepositoryAccess(data: bytes)
        let service = RepositoryService(makeAccess: { _ in access })
        let file = RepositoryFile(
            path: "model.safetensors",
            size: Int64(bytes.count),
            revision: nil,
            contentHash: nil,
            category: .weights
        )
        let snapshot = RepositorySnapshot(
            location: access.location,
            version: .live,
            files: [file]
        )

        _ = try await service.inspectFile(file, from: snapshot)
        let requestedRanges = await access.requestedRanges()
        XCTAssertEqual(
            requestedRanges,
            [0...7, 8...(7 + UInt64(header.count))]
        )

        let blocked = RepositoryFile(
            path: "pytorch_model.bin",
            size: 1_000,
            revision: nil,
            contentHash: nil,
            category: .weights
        )
        do {
            _ = try await service.inspectFile(blocked, from: snapshot)
            XCTFail("Expected blockedWeight")
        } catch let error as RepositoryService.ServiceError {
            guard case .blockedWeight = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        let finalRanges = await access.requestedRanges()
        XCTAssertEqual(finalRanges.count, 2)
    }

    func testServiceRoutesPDFAndRejectsUnknownBinary() async throws {
        let pdfData = Data("""
        %PDF-1.1
        1 0 obj
        << /Type /Catalog /Pages 2 0 R >>
        endobj
        2 0 obj
        << /Type /Pages /Kids [3 0 R] /Count 1 >>
        endobj
        3 0 obj
        << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>
        endobj
        trailer
        << /Root 1 0 R >>
        %%EOF
        """.utf8)
        let pdfAccess = RecordingRepositoryAccess(data: pdfData)
        let pdfService = RepositoryService(makeAccess: { _ in pdfAccess })
        let pdf = RepositoryFile(
            path: "paper.pdf",
            size: Int64(pdfData.count),
            revision: nil,
            contentHash: nil,
            category: FileClassifier.category(for: "paper.pdf")
        )
        let pdfSnapshot = RepositorySnapshot(location: pdfAccess.location, version: .live, files: [pdf])

        guard case let .pdf(loadedData) = try await pdfService.inspectFile(pdf, from: pdfSnapshot) else {
            return XCTFail("Expected PDF inspection")
        }
        XCTAssertEqual(loadedData, pdfData)
        let pdfRanges = await pdfAccess.requestedRanges()
        XCTAssertEqual(pdfRanges, [nil])

        let binaryAccess = RecordingRepositoryAccess(data: Data([0xFF, 0x00, 0xFE]))
        let binaryService = RepositoryService(makeAccess: { _ in binaryAccess })
        let binary = RepositoryFile(
            path: "unknown.data",
            size: 3,
            revision: nil,
            contentHash: nil,
            category: .other
        )
        let binarySnapshot = RepositorySnapshot(
            location: binaryAccess.location,
            version: .live,
            files: [binary]
        )

        do {
            _ = try await binaryService.inspectFile(binary, from: binarySnapshot)
            XCTFail("Expected unknown binary data to be rejected")
        } catch let error as RepositoryService.ServiceError {
            guard case .unsupportedBinary = error else { return XCTFail("Unexpected error: \(error)") }
        }
    }

    func testServiceKeepsSentencePieceInspectionLightweight() async throws {
        let data = Data([0x0A, 0x01, 0xFF, 0x00])
        let access = RecordingRepositoryAccess(data: data)
        let service = RepositoryService(makeAccess: { _ in access })
        let file = RepositoryFile(
            path: "tokenizer.model",
            size: Int64(data.count),
            revision: nil,
            contentHash: nil,
            category: .tokenizer
        )
        let snapshot = RepositorySnapshot(location: access.location, version: .live, files: [file])

        guard case let .generic(loadedData) = try await service.inspectFile(file, from: snapshot) else {
            return XCTFail("Expected SentencePiece data to remain available")
        }
        XCTAssertTrue(loadedData.isEmpty)
        let ranges = await access.requestedRanges()
        XCTAssertTrue(ranges.isEmpty)
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "ModelFilesTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

private struct EchoRepositoryAccess: RepositoryAccess {
    let location: RepositoryLocation

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: [])
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        Data()
    }
}

private actor RecordingRepositoryAccess: RepositoryAccess {
    nonisolated let location = RepositoryLocation.local(
        root: URL(fileURLWithPath: "/tmp/model-files-recording-access", isDirectory: true)
    )
    private let data: Data
    private var ranges: [ClosedRange<UInt64>?] = []

    init(data: Data) {
        self.data = data
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        RepositorySnapshot(location: location, version: .live, files: [])
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        ranges.append(range)
        guard let range else { return data }
        return data.subdata(in: Int(range.lowerBound)..<(Int(range.upperBound) + 1))
    }

    func requestedRanges() -> [ClosedRange<UInt64>?] {
        ranges
    }
}
