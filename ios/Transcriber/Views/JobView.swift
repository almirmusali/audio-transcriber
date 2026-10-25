import SwiftUI

struct JobView: View {
    @Environment(Library.self) private var library
    @Environment(Settings.self) private var settings
    @Environment(\.openURL) private var openURL
    let jobId: String

    @State private var job: Job?
    @State private var error: String?
    @State private var aiResult: AIResult?
    @State private var aiBusy: String?
    @State private var copied = false

    struct AIResult: Identifiable { let id = UUID(); var title: String; var text: String }

    var body: some View {
        ScrollView {
            if let job {
                VStack(alignment: .leading, spacing: 18) {
                    header(job)
                    if !job.finished { progress(job) }
                    if job.status == "error" { failure(job) }
                    if job.status == "done" { orbita(job) }
                    transcript(job)
                }
                .padding()
            } else if let error {
                ContentUnavailableView("Не открылось", systemImage: "wifi.exclamationmark", description: Text(error))
            } else {
                ProgressView().padding(.top, 80)
            }
        }
        .navigationTitle(job.map { displayName($0.name) } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if let job, job.status == "done" { actions(job) } }
        .sheet(item: $aiResult) { r in
            NavigationStack {
                ScrollView { Text(r.text).textSelection(.enabled).padding() }
                    .navigationTitle(r.title).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ShareLink(item: r.text) }
            }
        }
        // Пока идёт распознавание или отправка в Орбиту — опрашиваем сервер.
        .task(id: jobId) {
            while !Task.isCancelled {
                await load()
                let busy = job.map { !$0.finished || $0.meeting?.state == "sending" } ?? true
                try? await Task.sleep(for: .seconds(busy ? 1.5 : 30))
            }
        }
    }

    private func load() async {
        guard let api = settings.api else { return }
        do {
            job = try await api.job(jobId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    @ViewBuilder private func header(_ job: Job) -> some View {
        HStack(spacing: 8) {
            Text(job.date.formatted(date: .abbreviated, time: .shortened))
            if let s = job.seconds, s > 0 { Text("· " + durationText(s)) }
            if let n = job.speakerCount, n > 0 { Text("· 👥 \(n)") }
        }
        .font(.subheadline).foregroundStyle(.secondary)
        if let e = job.speakersError {
            Text("Говорящих разметить не вышло: \(e)").font(.footnote).foregroundStyle(.orange)
        }
    }

    @ViewBuilder private func progress(_ job: Job) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(StatusText.label(job.status, progress: job.progress, queue: job.queue)).font(.headline)
            if job.status == "recognizing" {
                ProgressView(value: Double(job.progress ?? 0), total: 100)
            } else {
                ProgressView().progressViewStyle(.linear)
            }
            Text("Распознаёт студия — приложение можно закрыть, результат подождёт здесь.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .padding()
        .glassEffect(in: .rect(cornerRadius: 20))
    }

    @ViewBuilder private func failure(_ job: Job) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(job.error ?? "Ошибка распознавания").foregroundStyle(.red)
            if let copy = library.localCopy(forJob: job.id) {
                Button("Распознать заново") { library.resend(copy.id) }.buttonStyle(.glass)
            }
        }
    }

    @ViewBuilder private func orbita(_ job: Job) -> some View {
        let m = job.meeting
        Group {
            switch m?.state {
            case "sending":
                Label("Отправляю в Орбиту… саммари она напишет сама", systemImage: "arrow.up.circle")
                    .foregroundStyle(.secondary)
            case "sent":
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        if let s = m?.url, let u = URL(string: s) { openURL(u) }
                    } label: {
                        Label("Открыть в Орбите", systemImage: "circle.hexagongrid.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent).tint(.purple)
                    if let name = OrbitaProjects.shared.name(m?.projectId) {
                        Text("Проект: \(name)").font(.footnote)
                    }
                    Text(m?.audioError.map { "Текст в Орбите, но запись не доехала: \($0)" }
                         ?? "Совещание в Орбите — саммари будет через пару минут")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            default:
                VStack(alignment: .leading, spacing: 6) {
                    // Выбор проекта и есть отправка: по умолчанию отмечен проект из настроек записи.
                    ProjectMenu(selected: settings.projectId) { p in
                        Task { await sendToOrbita(projectId: p?.id) }
                    } label: {
                        Label("Совещание в Орбиту…", systemImage: "circle.hexagongrid")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent).tint(.purple)
                    Text("Нажми и выбери проект — совещание уйдёт в него")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let e = m?.error {
                        Text(e).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
        }
    }

    @ViewBuilder private func transcript(_ job: Job) -> some View {
        let segs = job.segments ?? []
        if job.status == "done", segs.contains(where: { $0.speaker != nil }) {
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(Array(segs.enumerated()), id: \.offset) { _, s in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(s.speaker ?? "").font(.caption.weight(.semibold))
                                .foregroundStyle(speakerColor(s.speaker))
                            Text(clock(s.start)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                        }
                        Text(s.text).textSelection(.enabled)
                    }
                }
            }
        } else {
            let text = job.status == "done" ? (job.text ?? "") : (job.partial ?? "")
            Text(text.isEmpty ? " " : text)
                .textSelection(.enabled)
                .foregroundStyle(job.finished ? .primary : .secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ToolbarContentBuilder private func actions(_ job: Job) -> some ToolbarContent {
        ToolbarItemGroup {
            Button {
                UIPasteboard.general.string = job.text
                copied = true
                Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
            } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
            ShareLink(item: job.text ?? "")
            Menu {
                Button("Саммари и задачи") { Task { await ai("summary", "Саммари") } }
                Button("Причесать текст") { Task { await ai("clean", "Чистый текст") } }
                Button("Сделать пост") { Task { await ai("post", "Пост") } }
            } label: {
                if aiBusy != nil { ProgressView() } else { Image(systemName: "sparkles") }
            }
            .disabled(aiBusy != nil)
        }
    }

    private func sendToOrbita(projectId: String?) async {
        guard let api = settings.api else { return }
        job?.meeting = Meeting(state: "sending", projectId: projectId)
        do {
            job?.meeting = try await api.sendToOrbita(jobId, projectId: projectId)
        } catch {
            job?.meeting = Meeting(state: "error", error: error.localizedDescription)
        }
    }

    private func ai(_ preset: String, _ title: String) async {
        guard let api = settings.api else { return }
        aiBusy = preset
        defer { aiBusy = nil }
        do {
            aiResult = AIResult(title: title, text: try await api.ai(jobId, preset: preset))
        } catch {
            aiResult = AIResult(title: "Не вышло", text: error.localizedDescription)
        }
    }

    private func clock(_ t: Double) -> String {
        let s = Int(t)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                         : String(format: "%d:%02d", s / 60, s % 60)
    }

    private func speakerColor(_ label: String?) -> Color {
        let palette: [Color] = [.blue, .orange, .green, .purple, .pink, .teal, .brown, .indigo]
        let n = Int(label?.split(separator: " ").last ?? "") ?? 1
        return palette[(max(n, 1) - 1) % palette.count]
    }
}
