import AVFoundation
import Observation

// Запись для интерфейса: таймер, уровень, пауза, переживание звонков и смены микрофона.
// Сам звук пишет AudioCapture; файл и карточку записи ведёт Library.
@Observable
final class Recorder {
    enum State { case idle, recording, paused }

    private(set) var state: State = .idle
    private(set) var seconds: Double = 0
    private(set) var level: Float = 0
    private(set) var interrupted = false
    var error: String?

    private var capture: AudioCapture?
    private var recordingID: UUID?
    private var ticker: Timer?
    private var observers: [NSObjectProtocol] = []
    private var lastRetry = Date.distantPast

    var isActive: Bool { state != .idle }

    func start(library: Library, meeting: Bool) async {
        guard state == .idle else { return }
        error = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            error = "Нет доступа к микрофону: Настройки → Транскрибер → Микрофон"
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
            try session.setActive(true)
            let item = library.beginRecording(meeting: meeting)
            let cap = try AudioCapture()
            try cap.start(writingTo: library.fileURL(for: item))
            capture = cap
            recordingID = item.id
            state = .recording
            seconds = 0
            observe()
            ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        } catch {
            self.error = error.localizedDescription
            if let id = recordingID { library.discard(id) }
            cleanup()
        }
    }

    func togglePause() {
        guard let capture else { return }
        state = state == .paused ? .recording : .paused
        capture.setPaused(state == .paused)
    }

    func stop(library: Library) {
        guard let capture, let id = recordingID else { return }
        capture.stop()
        library.finishRecording(id, duration: capture.seconds)
        cleanup()
    }

    private func tick() {
        guard let capture else { return }
        seconds = capture.seconds
        level = state == .recording ? capture.currentLevel : 0
        // поднялись после звонка, а движок так и стоит — пробуем ещё раз
        if !interrupted, !capture.isRunning, Date().timeIntervalSince(lastRetry) > 2 {
            lastRetry = Date()
            resume()
        }
    }

    private func observe() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil,
                                        queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                .flatMap(AVAudioSession.InterruptionType.init) == .began
            MainActor.assumeIsolated {
                guard let self else { return }
                self.interrupted = began
                if !began { self.resume() }
            }
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil,
                                        queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.interrupted else { return }
                self.resume()
            }
        })
    }

    private func resume() {
        guard let capture, state != .idle else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            try capture.restart()
            interrupted = false
        } catch {
            self.error = "Запись прервалась: \(error.localizedDescription). Остановлю и сохраню то, что есть."
        }
    }

    private func cleanup() {
        ticker?.invalidate()
        ticker = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        capture = nil
        recordingID = nil
        state = .idle
        level = 0
        interrupted = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
