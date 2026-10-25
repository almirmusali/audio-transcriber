import SwiftUI
import UniformTypeIdentifiers

struct HomeView: View {
    @Environment(Library.self) private var library
    @Environment(Recorder.self) private var recorder
    @Environment(Settings.self) private var settings
    @Environment(\.scenePhase) private var phase
    @State private var picking = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section { RecordPanel(picking: $picking) }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())

                if let offline = library.offline {
                    Section {
                        Label(offline, systemImage: "wifi.exclamationmark")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                }

                if !library.pending.isEmpty {
                    Section("На телефоне") {
                        ForEach(library.pending) { PendingRow(item: $0) }
                    }
                }

                Section("История") {
                    if library.history.isEmpty {
                        Text(library.refreshing ? "Загружаю…" : "Пока пусто")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(library.history) { item in
                        NavigationLink(value: item.id) { HistoryRow(item: item) }
                            .swipeActions {
                                Button("Удалить", role: .destructive) {
                                    Task { await library.forget(item) }
                                }
                            }
                    }
                }
            }
            .navigationTitle("Транскрибер")
            .navigationDestination(for: String.self) { JobView(jobId: $0) }
            .toolbar {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
            .refreshable { await library.refresh() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.audio, .audiovisualContent],
                          allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { urls.forEach(library.importFile) }
            }
        }
        // Пока на студии что-то распознаётся — обновляем почаще, иначе раз в полминуты.
        .task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await library.refresh()
                try? await Task.sleep(for: .seconds(library.hasActiveJobs ? 3 : 30))
            }
        }
    }
}

struct RecordPanel: View {
    @Environment(Library.self) private var library
    @Environment(Recorder.self) private var recorder
    @Environment(Settings.self) private var settings
    @Binding var picking: Bool

    var body: some View {
        @Bindable var settings = settings
        VStack(spacing: 16) {
            if recorder.isActive {
                Text(Duration.seconds(recorder.seconds).formatted(.time(pattern: .hourMinuteSecond)))
                    .font(.system(size: 52, weight: .light, design: .rounded).monospacedDigit())
                LevelBar(level: recorder.level)
                Text(recorder.interrupted ? "Пауза на время звонка"
                     : recorder.state == .paused ? "Пауза" : "Пишу — экран можно погасить")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 28) {
                    Button { recorder.togglePause() } label: {
                        Image(systemName: recorder.state == .paused ? "play.fill" : "pause.fill")
                            .font(.title2).frame(width: 64, height: 64)
                    }
                    .buttonStyle(.glass)
                    .clipShape(Circle())
                    Button { recorder.stop(library: library) } label: {
                        Image(systemName: "stop.fill").font(.title).foregroundStyle(.white)
                            .frame(width: 84, height: 84)
                            .background(Circle().fill(.red))
                    }
                }
            } else {
                Button {
                    Task { await recorder.start(library: library, meeting: settings.meeting) }
                } label: {
                    Circle().fill(.red).frame(width: 96, height: 96)
                        .overlay(Image(systemName: "mic.fill").font(.largeTitle).foregroundStyle(.white))
                        .shadow(color: .red.opacity(0.35), radius: 14, y: 6)
                }
                .accessibilityLabel("Записать")
                Toggle(isOn: $settings.meeting) {
                    Label("Совещание → в Орбиту", systemImage: "circle.hexagongrid")
                }
                if settings.meeting {
                    ProjectMenu(selected: settings.projectId) { p in
                        settings.projectId = p?.id
                        settings.projectName = p?.title
                    } label: {
                        HStack {
                            Label("Проект", systemImage: "folder.badge.person.crop").foregroundStyle(.primary)
                            Spacer()
                            Text(settings.projectName ?? "Без проекта").lineLimit(1).foregroundStyle(.secondary)
                            Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Toggle(isOn: $settings.speakers) {
                    Label("Кто говорит", systemImage: "person.2.wave.2")
                }
                Button { picking = true } label: {
                    Label("Выбрать файл", systemImage: "folder").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
            }
            if let error = recorder.error {
                Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .glassEffect(in: .rect(cornerRadius: 28))
        .padding(.vertical, 8)
    }
}

struct LevelBar: View {
    var level: Float
    var body: some View {
        // уровень речи 0.01–0.3 RMS — переводим в шкалу по корню, чтобы тихий голос было видно
        let v = CGFloat(min(1, sqrt(Double(level)) * 2.2))
        GeometryReader { g in
            Capsule().fill(.quaternary)
                .overlay(alignment: .leading) {
                    Capsule().fill(.red.gradient).frame(width: max(6, g.size.width * v))
                        .animation(.linear(duration: 0.1), value: v)
                }
        }
        .frame(height: 8)
    }
}

struct PendingRow: View {
    @Environment(Library.self) private var library
    var item: LocalRecording

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.name).font(.body.weight(.medium))
            switch item.state {
            case .recording:
                Label("Идёт запись", systemImage: "record.circle").foregroundStyle(.red).font(.footnote)
            case .waiting:
                Text("Жду отправки…").font(.footnote).foregroundStyle(.secondary)
            case .uploading:
                ProgressView(value: item.progress) { Text("Отправляю на студию").font(.footnote) }
            case .failed:
                Text(item.error ?? "Не загрузилось").font(.footnote).foregroundStyle(.orange)
                HStack {
                    Button("Отправить снова") { library.upload(item.id) }
                    Spacer()
                    ShareLink(item: library.fileURL(for: item)) { Image(systemName: "square.and.arrow.up") }
                }
                .buttonStyle(.borderless)
            case .uploaded:
                EmptyView()
            }
        }
        .swipeActions {
            if item.state != .recording && item.state != .uploading {
                Button("Удалить", role: .destructive) { library.discard(item.id) }
            }
        }
    }
}

struct HistoryRow: View {
    var item: HistoryItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(displayName(item.name)).font(.body.weight(.medium)).lineLimit(1)
                Spacer()
                if item.meeting == "sent" { Image(systemName: "circle.hexagongrid.fill").foregroundStyle(.purple) }
            }
            HStack(spacing: 6) {
                Text(item.date.formatted(.relative(presentation: .named)))
                if let s = item.seconds, s > 0 { Text("· " + durationText(s)) }
                if let n = item.speakerCount, n > 0 { Text("· 👥 \(n)") }
                if !item.finished { Text("· " + StatusText.label(item.status)).foregroundStyle(.blue) }
                if item.status == "error" { Text("· ошибка").foregroundStyle(.red) }
            }
            .font(.caption).foregroundStyle(.secondary)
            if let p = item.preview, !p.isEmpty {
                Text(p).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }
}

func displayName(_ name: String) -> String {
    let ext = (name as NSString).pathExtension
    return ext.count <= 4 && !ext.isEmpty ? (name as NSString).deletingPathExtension : name
}

func durationText(_ s: Double) -> String {
    let m = Int(s) / 60
    return m >= 60 ? "\(m / 60) ч \(m % 60) мин" : m > 0 ? "\(m) мин" : "\(Int(s)) с"
}
