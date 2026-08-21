import Foundation

func validateRepositoryRelativePath(_ path: String) throws {
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty,
          !path.hasPrefix("/"),
          path.utf8.count <= LocalDirectoryAccess.maximumPathByteCount,
          components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
        throw RepositoryService.ServiceError.unsafePath(path)
    }
}

struct LocalDirectoryAccess: RepositoryAccess {
    static let maximumFileCount = 100_000
    static let maximumPathByteCount = 4 * 1_024

    let location: RepositoryLocation

    func loadSnapshot() async throws -> RepositorySnapshot {
        let task = Task.detached { try loadSnapshotSynchronously() }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        let task = Task.detached { try readSynchronously(file, range: range) }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func loadSnapshotSynchronously() throws -> RepositorySnapshot {
        try Task.checkCancellation()
        let root = try rootURL()
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        var traversalError: Error?
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: Array(keys),
            options: [],
            errorHandler: { _, error in
                traversalError = error
                return false
            }
        ) else {
            throw RepositoryService.ServiceError.directoryNotReadable
        }

        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        var files: [RepositoryFile] = []
        for case let url as URL in enumerator {
            try Task.checkCancellation()
            if let traversalError { throw traversalError }
            let values = try url.resourceValues(forKeys: keys)
            guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            guard url.path.hasPrefix(rootPrefix) else {
                throw RepositoryService.ServiceError.unsafePath(url.path)
            }
            let relativePath = String(url.path.dropFirst(rootPrefix.count))
            try validateRepositoryRelativePath(relativePath)
            files.append(RepositoryFile(
                path: relativePath,
                size: values.fileSize.map(Int64.init),
                revision: nil,
                contentHash: nil,
                category: FileClassifier.category(for: relativePath)
            ))
            guard files.count <= Self.maximumFileCount else {
                throw RepositoryService.ServiceError.tooManyFiles(Self.maximumFileCount)
            }
        }
        if let traversalError { throw traversalError }

        return RepositorySnapshot(
            location: .local(root: root),
            version: .live,
            files: files.sorted(by: RepositoryFile.displayOrder)
        )
    }

    private func readSynchronously(
        _ file: RepositoryFile,
        range: ClosedRange<UInt64>?
    ) throws -> Data {
        try Task.checkCancellation()
        let url = try fileURL(for: file.path)
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw RepositoryService.ServiceError.unsafePath(file.path)
        }
        if let expectedSize = file.size, values.fileSize.map(Int64.init) != expectedSize {
            throw RepositoryService.ServiceError.fileChanged(file.path)
        }

        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data: Data
        if let range {
            let count = range.upperBound - range.lowerBound + 1
            guard count <= UInt64(Int.max) else {
                throw RepositoryService.ServiceError.invalidResponse
            }
            try handle.seek(toOffset: range.lowerBound)
            data = try handle.read(upToCount: Int(count)) ?? Data()
            guard data.count == Int(count) else {
                throw RepositoryService.ServiceError.shortRead(expected: Int(count), actual: data.count)
            }
        } else {
            data = try handle.readToEnd() ?? Data()
        }
        if let expectedSize = file.size,
           try url.resourceValues(forKeys: [.fileSizeKey]).fileSize.map(Int64.init) != expectedSize {
            throw RepositoryService.ServiceError.fileChanged(file.path)
        }
        try Task.checkCancellation()
        return data
    }

    private func rootURL() throws -> URL {
        guard case let .local(root) = location else {
            throw RepositoryService.ServiceError.invalidLocalDirectory
        }
        let standardized = root.standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: standardized.path, isDirectory: &isDirectory),
              isDirectory.boolValue,
              FileManager.default.isReadableFile(atPath: standardized.path) else {
            throw RepositoryService.ServiceError.directoryNotReadable
        }
        let canonicalPath = try standardized.resourceValues(forKeys: [.canonicalPathKey]).canonicalPath
            ?? standardized.path
        return URL(fileURLWithPath: canonicalPath, isDirectory: true)
    }

    private func fileURL(for relativePath: String) throws -> URL {
        try validateRepositoryRelativePath(relativePath)
        let root = try rootURL()
        let candidate = root.appending(path: relativePath).standardizedFileURL
        let candidateValues = try candidate.resourceValues(forKeys: [.canonicalPathKey, .isSymbolicLinkKey])
        guard candidateValues.isSymbolicLink != true else {
            throw RepositoryService.ServiceError.unsafePath(relativePath)
        }
        let canonicalPath = candidateValues.canonicalPath ?? candidate.path
        let resolved = URL(fileURLWithPath: canonicalPath)
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard resolved.path.hasPrefix(rootPrefix) else {
            throw RepositoryService.ServiceError.unsafePath(relativePath)
        }
        return resolved
    }
}

struct SSHDirectoryAccess: RepositoryAccess {
    static let blockSize: UInt64 = 64 * 1_024
    static let maximumListingByteCount = 32 * 1_024 * 1_024

    let location: RepositoryLocation
    let runner: SSHProcessRunner

    init(location: RepositoryLocation, runner: SSHProcessRunner = SSHProcessRunner()) {
        self.location = location
        self.runner = runner
    }

    func loadSnapshot() async throws -> RepositorySnapshot {
        let output: SSHProcessOutput
        do {
            output = try await runner.run(
                arguments: sshArguments(),
                standardInput: Data(Self.listingScript.utf8),
                stdoutLimit: Self.maximumListingByteCount
            )
        } catch SSHProcessRunner.RunnerError.unavailable {
            throw RepositoryService.ServiceError.sshUnavailable
        } catch SSHProcessRunner.RunnerError.stdoutTooLarge {
            throw RepositoryService.ServiceError.listingTooLarge
        }
        try validate(output)
        return RepositorySnapshot(
            location: location,
            version: .live,
            files: try Self.parseListing(output.stdout)
        )
    }

    func read(_ file: RepositoryFile, range: ClosedRange<UInt64>?) async throws -> Data {
        try validateRepositoryRelativePath(file.path)
        guard let size = file.size, size >= 0 else {
            throw RepositoryService.ServiceError.missingFileSize
        }
        let fileSize = UInt64(size)
        let offset: UInt64
        let length: UInt64
        if let range {
            guard range.upperBound < fileSize else {
                throw RepositoryService.ServiceError.shortRead(expected: Int(range.count), actual: 0)
            }
            offset = range.lowerBound
            length = range.upperBound - range.lowerBound + 1
        } else {
            offset = 0
            length = fileSize
        }
        let window = try Self.readWindow(offset: offset, length: length)
        let output: SSHProcessOutput
        do {
            output = try await runner.run(
                arguments: sshArguments(extraRemoteArguments: [
                    file.path,
                    String(size),
                    String(window.skipBlocks),
                    String(window.blockCount),
                ]),
                standardInput: Data(Self.readScript.utf8),
                stdoutLimit: window.stdoutLimit
            )
        } catch SSHProcessRunner.RunnerError.unavailable {
            throw RepositoryService.ServiceError.sshUnavailable
        } catch SSHProcessRunner.RunnerError.stdoutTooLarge {
            throw RepositoryService.ServiceError.invalidResponse
        }
        if output.exitCode == 73 {
            throw RepositoryService.ServiceError.fileChanged(file.path)
        }
        try validate(output)
        let required = window.prefixByteCount + length
        guard required <= UInt64(output.stdout.count) else {
            throw RepositoryService.ServiceError.shortRead(
                expected: Int(length),
                actual: max(output.stdout.count - Int(window.prefixByteCount), 0)
            )
        }
        let lower = Int(window.prefixByteCount)
        return output.stdout.subdata(in: lower..<(lower + Int(length)))
    }

    static func parseListing(_ data: Data) throws -> [RepositoryFile] {
        if data.isEmpty { return [] }
        var fields = data.split(separator: 0, omittingEmptySubsequences: false)
        guard fields.last?.isEmpty == true else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        fields.removeLast()
        guard fields.count.isMultiple(of: 2) else {
            throw RepositoryService.ServiceError.invalidResponse
        }

        var files: [RepositoryFile] = []
        for index in stride(from: 0, to: fields.count, by: 2) {
            guard let path = String(data: Data(fields[index]), encoding: .utf8),
                  let rawSize = String(data: Data(fields[index + 1]), encoding: .utf8),
                  let size = Int64(rawSize.trimmingCharacters(in: .whitespacesAndNewlines)),
                  size >= 0 else {
                throw RepositoryService.ServiceError.invalidResponse
            }
            try validateRepositoryRelativePath(path)
            files.append(RepositoryFile(
                path: path,
                size: size,
                revision: nil,
                contentHash: nil,
                category: FileClassifier.category(for: path)
            ))
            guard files.count <= LocalDirectoryAccess.maximumFileCount else {
                throw RepositoryService.ServiceError.tooManyFiles(LocalDirectoryAccess.maximumFileCount)
            }
        }
        return files.sorted(by: RepositoryFile.displayOrder)
    }

    static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func readWindow(offset: UInt64, length: UInt64) throws -> SSHReadWindow {
        let skipBlocks = offset / blockSize
        let prefix = offset % blockSize
        let (total, totalOverflow) = prefix.addingReportingOverflow(length)
        let (rounded, roundedOverflow) = total.addingReportingOverflow(blockSize - 1)
        guard !totalOverflow, !roundedOverflow else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        let blockCount = rounded / blockSize
        let (maximumOutput, outputOverflow) = blockCount.multipliedReportingOverflow(by: blockSize)
        guard !outputOverflow, maximumOutput <= UInt64(Int.max) else {
            throw RepositoryService.ServiceError.invalidResponse
        }
        return SSHReadWindow(
            skipBlocks: skipBlocks,
            blockCount: blockCount,
            prefixByteCount: prefix,
            stdoutLimit: Int(maximumOutput)
        )
    }

    private func sshArguments(extraRemoteArguments: [String] = []) -> [String] {
        guard case let .ssh(ssh) = location else { return [] }
        var arguments = [
            "-T",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=2",
        ]
        if let port = ssh.port { arguments += ["-p", String(port)] }
        if let user = ssh.user { arguments += ["-l", user] }
        arguments += [ssh.host, "/bin/sh", "-s", "--", Self.shellQuote(ssh.rootPath)]
        arguments += extraRemoteArguments.map(Self.shellQuote)
        return arguments
    }

    private func validate(_ output: SSHProcessOutput) throws {
        guard output.exitCode == 0 else {
            let rawMessage = String(data: output.stderr, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var message = rawMessage.flatMap { $0.isEmpty ? nil : $0 }
                ?? String(localized: "远端命令失败。")
            if output.stderrWasTruncated { message += String(localized: "（stderr 已截断）") }
            throw RepositoryService.ServiceError.sshFailed(
                exitCode: output.exitCode,
                message: message
            )
        }
    }

    private static let listingScript = #"""
    set -eu
    root=$1
    test -d "$root" && test -r "$root" || exit 66
    cd "$root"
    find -P . -type f -exec sh -c '
      for path do
        relative=${path#./}
        size=$(wc -c < "$path") || exit 67
        printf "%s\000%s\000" "$relative" "$size"
      done
    ' sh {} +
    """#

    private static let readScript = #"""
    set -eu
    root=$1
    relative=$2
    expected=$3
    skip_blocks=$4
    block_count=$5
    cd "$root"
    test -f "$relative" && test ! -L "$relative" || exit 68
    actual=$(wc -c < "$relative" | tr -d '[:space:]')
    test "$actual" = "$expected" || exit 73
    dd if="$relative" bs=65536 skip="$skip_blocks" count="$block_count"
    """#
}

struct SSHReadWindow: Equatable, Sendable {
    let skipBlocks: UInt64
    let blockCount: UInt64
    let prefixByteCount: UInt64
    let stdoutLimit: Int
}

struct SSHProcessOutput: Sendable {
    let exitCode: Int32
    let stdout: Data
    let stderr: Data
    let stderrWasTruncated: Bool
}

struct SSHProcessRunner: Sendable {
    enum RunnerError: Error {
        case unavailable
        case stdoutTooLarge
    }

    let executableURL: URL

    init(executableURL: URL = URL(fileURLWithPath: "/usr/bin/ssh")) {
        self.executableURL = executableURL
    }

    func run(
        arguments: [String],
        standardInput: Data,
        stdoutLimit: Int
    ) async throws -> SSHProcessOutput {
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw RunnerError.unavailable
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        let box = SSHProcessBox(process: process)

        return try await withTaskCancellationHandler {
            try box.run()
            try? outputPipe.fileHandleForWriting.close()
            try? errorPipe.fileHandleForWriting.close()

            let stdoutTask = Task.detached {
                try Self.read(
                    outputPipe.fileHandleForReading,
                    limit: stdoutLimit,
                    terminateOnLimit: true,
                    process: box
                )
            }
            let stderrTask = Task.detached {
                try Self.read(
                    errorPipe.fileHandleForReading,
                    limit: 8 * 1_024,
                    terminateOnLimit: false,
                    process: box
                )
            }
            let waitTask = Task.detached { box.waitUntilExit() }

            do {
                try inputPipe.fileHandleForWriting.write(contentsOf: standardInput)
                try inputPipe.fileHandleForWriting.close()
                let exitCode = await waitTask.value
                let stdout = try await stdoutTask.value
                let stderr = try await stderrTask.value
                try Task.checkCancellation()
                return SSHProcessOutput(
                    exitCode: exitCode,
                    stdout: stdout.data,
                    stderr: stderr.data,
                    stderrWasTruncated: stderr.wasTruncated
                )
            } catch {
                box.cancel()
                if Task.isCancelled { throw CancellationError() }
                throw error
            }
        } onCancel: {
            box.cancel()
        }
    }

    private static func read(
        _ handle: FileHandle,
        limit: Int,
        terminateOnLimit: Bool,
        process: SSHProcessBox
    ) throws -> (data: Data, wasTruncated: Bool) {
        var data = Data()
        var wasTruncated = false
        while let chunk = try handle.read(upToCount: 64 * 1_024), !chunk.isEmpty {
            let remaining = max(limit - data.count, 0)
            data.append(chunk.prefix(remaining))
            if chunk.count > remaining {
                wasTruncated = true
                if terminateOnLimit { process.cancel() }
            }
        }
        if wasTruncated && terminateOnLimit { throw RunnerError.stdoutTooLarge }
        return (data, wasTruncated)
    }
}

private final class SSHProcessBox: @unchecked Sendable {
    private let process: Process
    private let lock = NSLock()
    private var isCancelled = false

    init(process: Process) {
        self.process = process
    }

    func run() throws {
        lock.lock()
        let cancelled = isCancelled
        lock.unlock()
        guard !cancelled else { throw CancellationError() }
        try process.run()

        lock.lock()
        let cancelAfterRun = isCancelled
        lock.unlock()
        if cancelAfterRun && process.isRunning { process.terminate() }
    }

    func waitUntilExit() -> Int32 {
        process.waitUntilExit()
        return process.terminationStatus
    }

    func cancel() {
        lock.lock()
        isCancelled = true
        let shouldTerminate = process.isRunning
        lock.unlock()
        if shouldTerminate { process.terminate() }
    }
}
