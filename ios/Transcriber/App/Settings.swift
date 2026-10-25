import Foundation
import Observation

@Observable
final class Settings {
    static let shared = Settings()

    // Адрес по умолчанию вшивается при сборке (Makefile берёт его из
    // ~/.config/transcriber/server-url), поэтому в репозитории его нет.
    static let builtInServer = (Bundle.main.object(forInfoDictionaryKey: "TranscriberServerURL") as? String ?? "")
        .trimmingCharacters(in: .whitespaces)

    var server: String { didSet { save("server", server) } }
    var lang: String { didSet { save("lang", lang) } }
    var speakers: Bool { didSet { save("speakers", speakers) } }
    var meeting: Bool { didSet { save("meeting", meeting) } }
    // Проект Орбиты, куда кладутся совещания с телефона; nil — без проекта.
    var projectId: String? { didSet { save("projectId", projectId ?? "") } }
    var projectName: String? { didSet { save("projectName", projectName ?? "") } }

    static let languages: [(code: String, name: String)] = [
        ("auto", "Определять сам"), ("ru", "Русский"), ("id", "Bahasa Indonesia"), ("en", "English"),
    ]

    private init() {
        let d = UserDefaults.standard
        server = d.string(forKey: "server") ?? Self.builtInServer
        lang = d.string(forKey: "lang") ?? "auto"
        speakers = d.object(forKey: "speakers") as? Bool ?? true
        meeting = d.object(forKey: "meeting") as? Bool ?? true
        projectId = d.string(forKey: "projectId").flatMap { $0.isEmpty ? nil : $0 }
        projectName = d.string(forKey: "projectName").flatMap { $0.isEmpty ? nil : $0 }
    }

    var api: API? {
        let s = server.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: s.hasSuffix("/") ? s : s + "/"), url.scheme?.hasPrefix("http") == true
        else { return nil }
        return API(base: url)
    }

    private func save(_ key: String, _ value: Any) { UserDefaults.standard.set(value, forKey: key) }
}
