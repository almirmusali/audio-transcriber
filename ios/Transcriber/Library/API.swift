import Foundation

// Сервер «Транскрибера» на Mac (server/server.mjs): распознаёт, размечает говорящих,
// отправляет совещание в Орбиту. Телефон только пишет звук и показывает результат.

nonisolated struct Segment: Codable, Hashable {
    var start: Double
    var end: Double
    var text: String
    var speaker: String?
}

nonisolated struct Meeting: Codable, Hashable {
    var state: String // sending | sent | error
    var url: String?
    var projectId: String?
    var error: String?
    var audioError: String?
}

nonisolated struct Job: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var status: String // queued | converting | recognizing | speakers | done | error | cancelled
    var progress: Int?
    var partial: String?
    var text: String?
    var seconds: Double?
    var createdAt: Double
    var recordedAt: Double?
    var queue: Int?
    var error: String?
    var segments: [Segment]?
    var speakerCount: Int?
    var speakersError: String?
    var meeting: Meeting?

    var finished: Bool { ["done", "error", "cancelled"].contains(status) }
    var date: Date { Date(timeIntervalSince1970: (recordedAt ?? createdAt) / 1000) }
}

nonisolated struct HistoryItem: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var status: String
    var seconds: Double?
    var createdAt: Double
    var preview: String?
    var speakerCount: Int?
    var meeting: String?

    var finished: Bool { ["done", "error", "cancelled"].contains(status) }
    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

nonisolated struct OrbitaProject: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var emoji: String?
    var status: String?

    var title: String { [emoji ?? "", name].filter { !$0.isEmpty }.joined(separator: " ") }
}

nonisolated struct Health: Codable {
    var ok: Bool
    var speakers: Bool?
    var orbita: Bool?
    var queue: Int?
}

nonisolated enum StatusText {
    static func label(_ status: String, progress: Int? = nil, queue: Int? = nil) -> String {
        switch status {
        case "queued": (queue ?? 0) > 1 ? "В очереди (\(queue!)-я)" : "В очереди"
        case "converting": "Готовлю аудио…"
        case "recognizing": "Распознаю… \(progress ?? 0)%"
        case "speakers": "Размечаю, кто говорит…"
        case "done": "Готово"
        case "error": "Ошибка"
        case "cancelled": "Остановлено"
        default: status
        }
    }
}

nonisolated struct APIError: LocalizedError {
    var message: String
    var network = false
    var errorDescription: String? { message }
}

nonisolated struct API: Sendable {
    var base: URL

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.timeoutIntervalForResource = 600 // ответы claude идут минуту-другую
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    func health() async throws -> Health { try await get("api/health") }
    func history() async throws -> [HistoryItem] {
        struct R: Codable { var items: [HistoryItem] }
        let r: R = try await get("api/history")
        return r.items
    }
    func job(_ id: String) async throws -> Job { try await get("api/jobs/\(id)") }

    // projectId == nil — совещание без проекта
    func sendToOrbita(_ id: String, projectId: String?) async throws -> Meeting {
        let body = try JSONSerialization.data(withJSONObject: ["projectId": projectId.map { $0 as Any } ?? NSNull()])
        return try await send("api/jobs/\(id)/orbita", method: "POST", body: body)
    }

    func orbitaProjects() async throws -> [OrbitaProject] {
        struct R: Codable { var projects: [OrbitaProject] }
        let r: R = try await get("api/orbita/projects")
        return r.projects
    }

    func ai(_ id: String, preset: String) async throws -> String {
        struct R: Codable { var text: String }
        var req = request("api/jobs/\(id)/ai", method: "POST")
        req.httpBody = try JSONEncoder().encode(["preset": preset])
        req.timeoutInterval = 300
        let r: R = try await run(req)
        return r.text
    }

    func cancel(_ id: String) async throws {
        let _: [String: Bool] = try await send("api/jobs/\(id)/cancel", method: "POST", body: Data())
    }

    func delete(_ id: String) async throws {
        let _: [String: Bool] = try await send("api/jobs/\(id)", method: "DELETE", body: nil)
    }

    // Загрузка записи: тело — сырые байты файла, параметры — в адресе.
    func uploadRequest(name: String, lang: String, speakers: Bool, orbita: Bool, project: String?,
                       fromMic: Bool, at: Date) -> URLRequest {
        var c = URLComponents(url: base.appending(path: "api/jobs"), resolvingAgainstBaseURL: false)!
        c.queryItems = [
            .init(name: "name", value: name),
            .init(name: "lang", value: lang),
            .init(name: "speakers", value: speakers ? "1" : "0"),
            .init(name: "speakerWord", value: "Спикер"),
            .init(name: "orbita", value: orbita ? "1" : "0"),
            .init(name: "project", value: orbita ? project : nil),
            .init(name: "mic", value: fromMic ? "1" : "0"),
            .init(name: "at", value: String(Int(at.timeIntervalSince1970 * 1000))),
        ]
        var req = URLRequest(url: c.url!)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        return req
    }

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        return req
    }

    private func get<T: Decodable>(_ path: String) async throws -> T { try await run(request(path)) }

    private func send<T: Decodable>(_ path: String, method: String, body: Data?) async throws -> T {
        var req = request(path, method: method)
        req.httpBody = body
        return try await run(req)
    }

    private func run<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await Self.session.data(for: req)
        } catch {
            throw APIError(message: "Студия недоступна. Включён ли Tailscale? (\(error.localizedDescription))", network: true)
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw APIError(message: msg ?? "Сервер ответил \(code)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
