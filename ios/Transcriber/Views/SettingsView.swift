import SwiftUI

struct SettingsView: View {
    @Environment(Settings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var check: String?

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section {
                    TextField("https://мак.тайлнет.ts.net:8443", text: $settings.server)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Проверить связь") { Task { await probe() } }
                    if let check { Text(check).font(.footnote) }
                } header: {
                    Text("Студия")
                } footer: {
                    Text("Распознаёт Mac, на котором запущен веб-сервер Транскрибера. Телефон ходит к нему через Tailscale.")
                }
                Section("Распознавание") {
                    Picker("Язык", selection: $settings.lang) {
                        ForEach(Settings.languages, id: \.code) { Text($0.name).tag($0.code) }
                    }
                    Toggle("Кто говорит", isOn: $settings.speakers)
                    Toggle("Совещание сразу в Орбиту", isOn: $settings.meeting)
                }
            }
            .navigationTitle("Настройки")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Готово") { dismiss() } }
        }
    }

    private func probe() async {
        guard let api = settings.api else { check = "Адрес не похож на ссылку"; return }
        check = "Проверяю…"
        do {
            let h = try await api.health()
            check = "✓ Студия на связи" +
                (h.speakers == true ? " · спикеры есть" : " · без разметки спикеров") +
                (h.orbita == true ? " · Орбита подключена" : " · Орбита не настроена")
        } catch {
            check = error.localizedDescription
        }
    }
}
