import Foundation
import Observation

// Записи на телефоне, пока они не доехали до студии, и история заданий со студии.
//
// Файл записи живёт на телефоне, пока сервер не закончил распознавание: если что-то
// сорвалось (студия перезагрузилась, Tailscale выключен), запись можно отправить снова.
nonisolated struct LocalRecording: Codable, Identifiable, Hashable {
    enum State: String, Codable { case recording, waiting, uploading, failed, uploaded }

    var id = UUID()
    var file: String
    var name: String
    var startedAt: Date
    var duration: Double = 0
    var fromMic: Bool
    var meeting: Bool
    var state: State
    var progress: Double = 0
    var error: String?
    // не доехала из-за сети (нет Tailscale, студия спит) — отправим сама, когда студия ответит
    var retryable: Bool? = false
    var jobId: String?
}

@Observable
final class Library {
    static let shared = Library()

    private(set) var local: [LocalRecording] = []
    private(set) var history: [HistoryItem] = []
    private(set) var offline: String?
    var refreshing = false

    private let settings = Settings.shared
    private let uploader = Uploader.shared

    private static let dir: URL = {
        let d = URL.documentsDirectory.appending(path: "Записи", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private static let index = URL.applicationSupportDirectory.appending(path: "recordings.json")

    private init() {
        if let data = try? Data(contentsOf: Self.index),
           let items = try? JSONDecoder().decode([LocalRecording].self, from: data) {
            local = items
        }
        uploader.onFinish = { [weak self] id, result in self?.uploadFinished(id, result) }
        uploader.onProgress = { [weak self] id, p in self?.update(id) { $0.progress = p } }
        uploader.wake()
        recover()
    }

    func fileURL(for item: LocalRecording) -> URL { Self.dir.appending(path: item.file) }

    // Карточки «на телефоне»: пишется, грузится или не загрузилось.
    var pending: [LocalRecording] { local.filter { $0.state != .uploaded } }

    // MARK: запись

    func beginRecording(meeting: Bool) -> LocalRecording {
        let now = Date()
        let item = LocalRecording(file: "\(Self.stamp(now)).aac",
                                  name: (meeting ? "Совещание " : "Запись ") + Self.title(now),
                                  startedAt: now, fromMic: true, meeting: meeting, state: .recording)
        local.insert(item, at: 0)
        persist()
        return item
    }

    func finishRecording(_ id: UUID, duration: Double) {
        update(id) {
            $0.duration = duration
            $0.state = .waiting
        }
        upload(id)
    }

    func discard(_ id: UUID) {
        guard let item = local.first(where: { $0.id == id }) else { return }
        try? FileManager.default.removeItem(at: fileURL(for: item))
        local.removeAll { $0.id == id }
        persist()
    }

    // «Поделиться» из Диктофона или выбор в «Файлах».
    func importFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let ext = url.pathExtension.isEmpty ? "m4a" : url.pathExtension.lowercased()
        let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? Date()
        let name = url.deletingPathExtension().lastPathComponent
        let file = "\(Self.stamp(Date()))-\(UUID().uuidString.prefix(4)).\(ext)"
        do {
            try FileManager.default.copyItem(at: url, to: Self.dir.appending(path: file))
        } catch {
            offline = "Не удалось взять файл: \(error.localizedDescription)"
            return
        }
        // входящие копии из «Поделиться» система кладёт в Inbox — убираем за собой
        if url.path.contains("/Inbox/") { try? FileManager.default.removeItem(at: url) }
        let item = LocalRecording(file: file, name: name, startedAt: created, fromMic: false,
                                  meeting: settings.meeting, state: .waiting)
        local.insert(item, at: 0)
        persist()
        upload(item.id)
    }

    // MARK: загрузка

    func upload(_ id: UUID) {
        guard let item = local.first(where: { $0.id == id }) else { return }
        guard let api = settings.api else {
            update(id) { $0.state = .failed; $0.error = "Не задан адрес студии — открой настройки" }
            return
        }
        let req = api.uploadRequest(name: item.name + "." + (item.file as NSString).pathExtension,
                                    lang: settings.lang, speakers: settings.speakers,
                                    orbita: item.meeting, fromMic: item.fromMic, at: item.startedAt)
        update(id) {
            $0.state = .uploading
            $0.progress = 0
            $0.error = nil
        }
        uploader.upload(id, file: fileURL(for: item), request: req)
    }

    private func uploadFinished(_ id: UUID, _ result: Result<String, Error>) {
        switch result {
        case .success(let jobId):
            update(id) {
                $0.state = .uploaded
                $0.jobId = jobId
                $0.progress = 1
            }
            Task { await refresh() }
        case .failure(let error):
            update(id) {
                $0.state = .failed
                $0.error = error.localizedDescription
                $0.retryable = (error as? APIError)?.network ?? true
            }
        }
    }

    // Запись, которую сервер не смог разобрать, — отправить заново тем же файлом.
    func localCopy(forJob jobId: String) -> LocalRecording? { local.first { $0.jobId == jobId } }

    func resend(_ id: UUID) {
        update(id) { $0.jobId = nil }
        upload(id)
    }

    // После перезапуска приложения: запись, оборванную системой, отправляем как есть
    // (ADTS читается до последнего кадра), а загрузки без живой фоновой задачи — заново.
    private func recover() {
        for item in local where item.state == .recording {
            update(item.id) {
                $0.state = .waiting
                $0.name += " (прервана)"
            }
            upload(item.id)
        }
        Task {
            let active = await uploader.activeUploads()
            for item in local where item.state == .uploading && !active.contains(item.id) {
                upload(item.id)
            }
        }
    }

    // MARK: история со студии

    func refresh() async {
        guard let api = settings.api else {
            offline = "Не задан адрес студии — открой настройки"
            return
        }
        refreshing = true
        defer { refreshing = false }
        do {
            history = try await api.history()
            offline = nil
            cleanup()
            for item in local where item.state == .failed && item.retryable == true { upload(item.id) }
        } catch {
            offline = error.localizedDescription
        }
    }

    var hasActiveJobs: Bool {
        history.contains { !$0.finished } || local.contains { $0.state == .uploading || $0.state == .recording }
    }

    func forget(_ item: HistoryItem) async {
        try? await settings.api?.delete(item.id)
        if let copy = localCopy(forJob: item.id) { discard(copy.id) }
        history.removeAll { $0.id == item.id }
    }

    // Распознано на студии — копия на телефоне больше не нужна. Задание, выпавшее из
    // истории сервера (он держит 50 последних), тоже чистим, если ему больше недели.
    private func cleanup() {
        let byId = Dictionary(history.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for item in local where item.state == .uploaded {
            guard let jobId = item.jobId else { continue }
            if byId[jobId]?.status == "done" ||
                (byId[jobId] == nil && item.startedAt < Date().addingTimeInterval(-7 * 86400)) {
                discard(item.id)
            }
        }
    }

    // MARK: служебное

    private func update(_ id: UUID, _ change: (inout LocalRecording) -> Void) {
        guard let i = local.firstIndex(where: { $0.id == id }) else { return }
        change(&local[i])
        if local[i].state != .uploading || local[i].progress == 0 || local[i].progress == 1 { persist() }
    }

    private func persist() {
        try? FileManager.default.createDirectory(at: Self.index.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? JSONEncoder().encode(local).write(to: Self.index, options: .atomic)
    }

    private static func stamp(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH-mm-ss"
        return f.string(from: d)
    }

    static func title(_ d: Date) -> String {
        d.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "ru_RU")))
    }
}
