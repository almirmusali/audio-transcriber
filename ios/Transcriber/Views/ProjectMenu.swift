import SwiftUI
import Observation

// Проекты Орбиты: грузим со студии при первом открытии меню и держим до перезапуска.
@Observable
final class OrbitaProjects {
    static let shared = OrbitaProjects()
    private(set) var items: [OrbitaProject] = []
    private(set) var error: String?
    private(set) var loading = false

    func load() async {
        guard !loading, let api = Settings.shared.api else { return }
        loading = true
        defer { loading = false }
        do {
            items = try await api.orbitaProjects()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func name(_ id: String?) -> String? { id.flatMap { id in items.first { $0.id == id }?.title } }
}

// Меню выбора проекта: «Без проекта» и живые проекты Орбиты, сначала активные.
struct ProjectMenu<Label: View>: View {
    var selected: String?
    var onPick: (OrbitaProject?) -> Void
    @ViewBuilder var label: () -> Label
    @State private var store = OrbitaProjects.shared

    var body: some View {
        Menu {
            Button { onPick(nil) } label: {
                if selected == nil { SwiftUI.Label("Без проекта", systemImage: "checkmark") } else { Text("Без проекта") }
            }
            Divider()
            if store.items.isEmpty {
                Text(store.loading ? "Загружаю проекты…" : store.error ?? "Проектов нет")
            }
            ForEach(store.items) { p in
                Button { onPick(p) } label: {
                    if p.id == selected { SwiftUI.Label(p.title, systemImage: "checkmark") } else { Text(p.title) }
                }
            }
        } label: {
            label()
        }
        .task { if store.items.isEmpty { await store.load() } }
    }
}
