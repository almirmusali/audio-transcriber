import Foundation

// Загрузка записей фоновой сессией: телефон можно заблокировать сразу после «Стоп» —
// файл дольётся на студию сам, даже если система выгрузит приложение.
nonisolated final class Uploader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = Uploader()
    static let identifier = "com.almirmusalimov.transcriber.upload"

    // Вызывается на главном потоке: (id записи, id задания на сервере или ошибка).
    var onFinish: (@MainActor (UUID, Result<String, Error>) -> Void)?
    var onProgress: (@MainActor (UUID, Double) -> Void)?
    var backgroundCompletion: (() -> Void)?

    private let lock = NSLock()
    private var bodies: [Int: Data] = [:]

    private var session: URLSession!

    override private init() {
        super.init()
        let c = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        c.isDiscretionary = false
        c.sessionSendsLaunchEvents = true
        c.timeoutIntervalForResource = 6 * 3600
        session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    func wake() { _ = session }

    func upload(_ id: UUID, file: URL, request: URLRequest) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = id.uuidString
        task.resume()
    }

    func activeUploads() async -> Set<UUID> {
        let tasks = await session.allTasks
        return Set(tasks.filter { $0.state == .running || $0.state == .suspended }
            .compactMap { $0.taskDescription.flatMap(UUID.init) })
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock { bodies[dataTask.taskIdentifier, default: Data()].append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let id = task.taskDescription.flatMap(UUID.init), totalBytesExpectedToSend > 0 else { return }
        let p = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        Task { @MainActor in self.onProgress?(id, p) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = lock.withLock { bodies.removeValue(forKey: task.taskIdentifier) } ?? Data()
        guard let id = task.taskDescription.flatMap(UUID.init) else { return }
        let result: Result<String, Error>
        let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        if let error {
            result = .failure(APIError(message: "Не загрузилось: \(error.localizedDescription). Включён ли Tailscale?", network: true))
        } else if code == 200, let jobId = json?["id"] as? String {
            result = .success(jobId)
        } else {
            result = .failure(APIError(message: json?["error"] as? String ?? "Сервер ответил \(code)"))
        }
        Task { @MainActor in self.onFinish?(id, result) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }
}
