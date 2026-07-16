import Foundation

final class HTTPRangeLoader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum RangeError: LocalizedError {
        case unsupported(Int)
        case incomplete(expected: Int, received: Int)

        var errorDescription: String? {
            switch self {
            case let .unsupported(status):
                "源站未确认 HTTP Range（状态码 \(status)），已取消以避免下载完整权重。"
            case let .incomplete(expected, received):
                "Range 响应不完整：需要 \(expected) 字节，只收到 \(received) 字节。"
            }
        }
    }

    private let expectedCount: Int
    private let lock = NSLock()
    private var data = Data()
    private var continuation: CheckedContinuation<Data, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var finished = false

    private init(expectedCount: Int) {
        self.expectedCount = expectedCount
        data.reserveCapacity(expectedCount)
    }

    static func fetch(_ request: URLRequest, expectedCount: Int) async throws -> Data {
        let loader = HTTPRangeLoader(expectedCount: expectedCount)
        return try await withTaskCancellationHandler {
            try await loader.start(request)
        } onCancel: {
            loader.cancel()
        }
    }

    private func start(_ request: URLRequest) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: queue)
            self.session = session
            let task = session.dataTask(with: request)
            self.task = task
            lock.unlock()
            task.resume()
        }
    }

    private func cancel() {
        task?.cancel()
        finish(.failure(CancellationError()))
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 206 else {
            completionHandler(.cancel)
            finish(.failure(RangeError.unsupported(status)))
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        let remaining = expectedCount - data.count
        data.append(chunk.prefix(max(remaining, 0)))
        let result = data.count == expectedCount ? data : nil
        lock.unlock()

        if let result {
            dataTask.cancel()
            finish(.success(result))
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        let received = data.count
        let alreadyFinished = finished
        lock.unlock()
        guard !alreadyFinished else { return }
        if let error {
            finish(.failure(error))
        } else {
            finish(.failure(RangeError.incomplete(expected: expectedCount, received: received)))
        }
    }

    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        let continuation = continuation
        self.continuation = nil
        let session = session
        self.session = nil
        self.task = nil
        lock.unlock()

        session?.invalidateAndCancel()
        continuation?.resume(with: result)
    }
}
