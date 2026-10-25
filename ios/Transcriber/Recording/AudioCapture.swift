import AVFoundation

// Запись с микрофона в AAC с заголовками ADTS (.aac).
//
// Почему не AVAudioRecorder: и m4a, и AAC в CAF дописывают оглавление (moov, pakt) только
// при закрытии файла. Если систему убьёт приложение посреди часового совещания, такой файл
// не читается совсем. В ADTS у каждого кадра свой заголовок — файл годен до последнего
// записанного кадра, что бы ни случилось.
//
// Цепочка: микрофон (любой формат железа) → PCM 24 кГц моно → AAC-LC 48 кбит/с ≈ 21 МБ в час.
// Выходной формат фиксированный, поэтому смена микрофона (наушники, Bluetooth) посреди
// записи пересоздаёт только первый конвертер, а поток кадров остаётся однородным.
nonisolated final class AudioCapture: @unchecked Sendable {
    static let sampleRate: Double = 24_000
    private static let sampleRateIndex: UInt8 = 6 // 24 кГц в таблице ADTS
    private static let bitRate = 48_000

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                          channels: 1, interleaved: false)!
    private let aacFormat: AVAudioFormat
    private var resampler: AVAudioConverter?
    private let encoder: AVAudioConverter
    private var file: FileHandle?

    // под lock
    private var paused = false
    private var frames: Int64 = 0
    private var level: Float = 0

    init() throws {
        var desc = AudioStreamBasicDescription(
            mSampleRate: Self.sampleRate, mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: AudioFormatFlags(MPEG4ObjectID.AAC_LC.rawValue),
            mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
            mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard let aac = AVAudioFormat(streamDescription: &desc),
              let enc = AVAudioConverter(from: pcmFormat, to: aac)
        else { throw CaptureError.encoder }
        enc.bitRate = Self.bitRate
        aacFormat = aac
        encoder = enc
    }

    var seconds: Double { lock.withLock { Double(frames) / Self.sampleRate } }
    var currentLevel: Float { lock.withLock { level } }
    var isRunning: Bool { engine.isRunning }

    func setPaused(_ on: Bool) { lock.withLock { paused = on } }

    func start(writingTo url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        file = try FileHandle(forWritingTo: url)
        try installTap()
        engine.prepare()
        try engine.start()
    }

    // После звонка или смены микрофона движок стоит — поднимаем заново, файл тот же.
    func restart() throws {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        try installTap()
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        lock.withLock {
            encode(nil) // дожать хвост кодера
            try? file?.synchronize()
            try? file?.close()
            file = nil
        }
    }

    private func installTap() throws {
        let input = engine.inputNode
        let hw = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else { throw CaptureError.noMicrophone }
        guard let conv = AVAudioConverter(from: hw, to: pcmFormat) else { throw CaptureError.encoder }
        conv.downmix = true
        lock.withLock { resampler = conv }
        input.installTap(onBus: 0, bufferSize: 4096, format: hw) { [weak self] buffer, _ in
            self?.consume(buffer)
        }
    }

    private func consume(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            level = Self.rms(buffer)
            guard !paused, file != nil, let resampler else { return }
            let ratio = Self.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
            guard let pcm = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: capacity) else { return }
            var given = false
            var error: NSError?
            resampler.convert(to: pcm, error: &error) { _, status in
                if given { status.pointee = .noDataNow; return nil }
                given = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, pcm.frameLength > 0 else { return }
            frames += Int64(pcm.frameLength)
            encode(pcm)
        }
    }

    // pcm == nil — конец потока: кодер отдаёт всё, что держал внутри.
    private func encode(_ pcm: AVAudioPCMBuffer?) {
        guard let file else { return }
        var given = false
        while true {
            let out = AVAudioCompressedBuffer(format: aacFormat, packetCapacity: 16,
                                              maximumPacketSize: max(encoder.maximumOutputPacketSize, 1536))
            var error: NSError?
            let status = encoder.convert(to: out, error: &error) { _, inStatus in
                guard let pcm else { inStatus.pointee = .endOfStream; return nil }
                if given { inStatus.pointee = .noDataNow; return nil }
                given = true
                inStatus.pointee = .haveData
                return pcm
            }
            if error != nil { return }
            write(out, to: file)
            if status != .haveData || out.packetCount == 0 { return }
        }
    }

    private func write(_ out: AVAudioCompressedBuffer, to file: FileHandle) {
        guard out.packetCount > 0, let descs = out.packetDescriptions else { return }
        var chunk = Data()
        for i in 0..<Int(out.packetCount) {
            let d = descs[i]
            let size = Int(d.mDataByteSize)
            chunk.append(contentsOf: Self.adtsHeader(payload: size))
            chunk.append(Data(bytes: out.data.advanced(by: Int(d.mStartOffset)), count: size))
        }
        try? file.write(contentsOf: chunk)
    }

    // 7 байт ADTS без CRC: AAC-LC, 24 кГц, моно.
    private static func adtsHeader(payload: Int) -> [UInt8] {
        let len = payload + 7
        let profile: UInt8 = 1 // AAC-LC (object type 2) минус 1
        let channels: UInt8 = 1
        return [
            0xFF, 0xF1,
            (profile << 6) | (sampleRateIndex << 2) | (channels >> 2),
            ((channels & 3) << 6) | UInt8((len >> 11) & 0x03),
            UInt8((len >> 3) & 0xFF),
            UInt8((len & 0x07) << 5) | 0x1F,
            0xFC,
        ]
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        return (sum / Float(n)).squareRoot()
    }

    enum CaptureError: LocalizedError {
        case encoder, noMicrophone
        var errorDescription: String? {
            switch self {
            case .encoder: "Не удалось запустить кодировщик AAC"
            case .noMicrophone: "Микрофон недоступен"
            }
        }
    }
}
