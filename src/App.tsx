import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeToPcm } from './audio'
import {
  type Chunk,
  type TranscriptOutput,
  formatTime,
  toSrt,
  parseSrt,
  download,
} from './format'

type Phase = 'idle' | 'working' | 'done' | 'error'
type ModelKey = 'turbo' | 'base'

interface FinalResult {
  text: string
  srt: string
  segments: Chunk[]
  savedPath: string | null
  recordingPath?: string | null
  mdPath?: string | null
  fileCount?: number
  failed?: number
}

// code — для нативного whisper.cpp, name — для transformers.js в браузере.
const LANGUAGES: { code: string; name: string; label: string }[] = [
  { code: '', name: '', label: 'Автоопределение' },
  { code: 'ru', name: 'russian', label: 'Русский' },
  { code: 'en', name: 'english', label: 'English' },
  { code: 'uk', name: 'ukrainian', label: 'Українська' },
  { code: 'kk', name: 'kazakh', label: 'Қазақша' },
  { code: 'de', name: 'german', label: 'Deutsch' },
  { code: 'fr', name: 'french', label: 'Français' },
  { code: 'es', name: 'spanish', label: 'Español' },
  { code: 'id', name: 'indonesian', label: 'Bahasa Indonesia' },
]

function useModelProgress() {
  const [files, setFiles] = useState<Record<string, number>>({})
  const reset = () => setFiles({})
  const update = (p: any) => {
    if (p.status === 'progress' && p.file)
      setFiles((prev) => ({ ...prev, [p.file]: p.progress ?? 0 }))
    if (p.status === 'done' && p.file)
      setFiles((prev) => ({ ...prev, [p.file]: 100 }))
  }
  const values = Object.values(files)
  const overall =
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
  return { overall, reset, update, active: values.length > 0 }
}

export default function App() {
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined
  const isDesktop = !!desktop

  const [phase, setPhase] = useState<Phase>('idle')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [final, setFinal] = useState<FinalResult | null>(null)
  const [fileName, setFileName] = useState('')
  const [model, setModel] = useState<ModelKey>('turbo')
  const [langCode, setLangCode] = useState('')
  const [hasWebGPU, setHasWebGPU] = useState<boolean | null>(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [fast, setFast] = useState(false)
  const [partial, setPartial] = useState('')
  const [pct, setPct] = useState<number | null>(null)
  const [course, setCourse] = useState<{
    index: number
    total: number
    name: string
  } | null>(null)

  const progress = useModelProgress()
  const workerRef = useRef<Worker | null>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  const lang = LANGUAGES.find((l) => l.code === langCode) ?? LANGUAGES[0]

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  function beginUI(name: string) {
    setPhase('working')
    setError('')
    setFinal(null)
    setPartial('')
    setPct(null)
    setCourse(null)
    setStatus(isDesktop ? 'Подготовка…' : 'Декодирование аудио…')
    setFileName(name)
    progress.reset()
    startRef.current = Date.now()
    setElapsed(0)
    stopTimer()
    timerRef.current = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      1000,
    )
  }

  // ===== Нативный режим (Electron + whisper.cpp / Metal) =====
  useEffect(() => {
    if (!desktop) return
    const offs = [
      desktop.onStatus((v) => setStatus(v)),
      desktop.onPartial((v) => setPartial(v)),
      desktop.onProgress((v) => setPct(v)),
      desktop.onCourseProgress((v) => setCourse(v)),
    ]
    return () => offs.forEach((off) => off())
  }, [desktop])

  async function runDesktop(payload: {
    path?: string
    bytes?: ArrayBuffer
    name: string
  }) {
    beginUI(payload.name)
    try {
      const res = await desktop!.transcribe({
        path: payload.path,
        bytes: payload.bytes,
        name: payload.name,
        language: lang.code,
        fast,
      })
      setFinal({
        text: res.text,
        srt: res.srt,
        segments: parseSrt(res.srt),
        savedPath: res.savedPath,
        recordingPath: res.recordingPath ?? null,
      })
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    } finally {
      stopTimer()
    }
  }

  // ===== Папочный режим: транскрипция всего курса в один .md =====
  async function pickFolder() {
    const dir = await desktop!.openFolder()
    if (dir) runCourse(dir)
  }

  async function runCourse(dir: string) {
    const name = dir.split('/').pop() || 'Курс'
    beginUI(name)
    try {
      const res = await desktop!.transcribeCourse({
        dir,
        language: lang.code,
        fast,
      })
      setFinal({
        text: res.md,
        srt: '',
        segments: [],
        savedPath: null,
        mdPath: res.mdPath,
        fileCount: res.fileCount,
        failed: res.failed,
      })
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    } finally {
      stopTimer()
    }
  }

  // ===== Браузерный режим (transformers.js / WebGPU) =====
  useEffect(() => {
    if (isDesktop) return
    const gpu = (navigator as any).gpu
    if (!gpu) {
      setHasWebGPU(false)
      setModel('base')
      return
    }
    gpu
      .requestAdapter()
      .then((a: any) => {
        setHasWebGPU(!!a)
        if (!a) setModel('base')
      })
      .catch(() => {
        setHasWebGPU(false)
        setModel('base')
      })
  }, [isDesktop])

  useEffect(() => {
    if (isDesktop) return
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('message', (e: MessageEvent) => {
      const { type, payload } = e.data
      if (type === 'progress') progress.update(payload)
      else if (type === 'status') setStatus(payload)
      else if (type === 'partial') setPartial(payload as string)
      else if (type === 'result') {
        const out = payload as TranscriptOutput
        const segs = (out.chunks ?? []).filter((c) => c.text.trim())
        const text = (out.text ?? '').trim()
        setFinal({
          text,
          srt: segs.length ? toSrt(segs) : '',
          segments: segs,
          savedPath: null,
        })
        setPhase('done')
        stopTimer()
        if (text) download('transcript.txt', text)
      } else if (type === 'error') {
        setError(payload)
        setPhase('error')
        stopTimer()
      }
    })
    workerRef.current = worker
    return () => worker.terminate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop])

  async function runBrowser(blob: Blob, name: string) {
    beginUI(name)
    try {
      const pcm = await decodeToPcm(blob)
      const device = hasWebGPU ? 'webgpu' : 'wasm'
      workerRef.current!.postMessage(
        { type: 'transcribe', audio: pcm, model, device, language: lang.name || null },
        [pcm.buffer],
      )
    } catch (err) {
      setError(
        'Не удалось декодировать файл. ' +
          (err instanceof Error ? err.message : ''),
      )
      setPhase('error')
      stopTimer()
    }
  }

  // ===== Общие обработчики ввода =====
  async function pickFile() {
    if (isDesktop) {
      const p = await desktop!.openFile()
      if (p) runDesktop({ path: p, name: p.split('/').pop() || 'audio' })
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) runBrowser(f, f.name)
    e.target.value = ''
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    if (isDesktop) {
      const p = desktop!.pathForFile(f)
      if (p) runDesktop({ path: p, name: f.name })
    } else {
      runBrowser(f, f.name)
    }
  }

  async function toggleRecording() {
    if (recording) {
      mediaRef.current?.stop()
      return
    }
    // В нативном приложении сначала спрашиваем доступ к микрофону у macOS.
    if (isDesktop) {
      const r = await desktop!.requestMic()
      if (r === 'denied') {
        setError(
          'Нет доступа к микрофону. Открой Системные настройки → ' +
            'Конфиденциальность и безопасность → Микрофон и включи «Транскрибер», ' +
            'затем перезапусти приложение.',
        )
        setPhase('error')
        return
      }
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (ev) => ev.data.size && chunksRef.current.push(ev.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        if (isDesktop) {
          const bytes = await blob.arrayBuffer()
          runDesktop({ bytes, name: 'Запись с микрофона.webm' })
        } else {
          runBrowser(blob, 'Запись с микрофона')
        }
      }
      rec.start()
      mediaRef.current = rec
      setRecording(true)
    } catch {
      setError('Нет доступа к микрофону.')
      setPhase('error')
    }
  }

  // ===== Экспорт результата =====
  async function saveText(name: string, content: string) {
    if (isDesktop) await desktop!.saveAs(name, content)
    else download(name, content)
  }

  const segments = final?.segments ?? []
  const plainText = final?.text ?? ''
  const busy = phase === 'working'

  return (
    <div className="app">
      <header>
        <h1>🎙️ Транскрибер</h1>
        <p className="sub">
          {isDesktop ? (
            <>
              Аудио → текст нативно на Mac. Модель <b>Whisper large-v3-turbo</b>,
              ускорение Metal. Всё локально.
            </>
          ) : (
            <>
              Аудио → текст прямо в браузере. Модель <b>Whisper</b>, ничего не
              уходит на сервер.
            </>
          )}
        </p>
      </header>

      <section className="controls">
        {!isDesktop && (
          <div className="field">
            <label>Модель</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelKey)}
              disabled={busy}
            >
              <option value="turbo" disabled={hasWebGPU === false}>
                Лучшая · large-v3-turbo{' '}
                {hasWebGPU === false ? '(нужен WebGPU)' : ''}
              </option>
              <option value="base">Быстрая · base (работает везде)</option>
            </select>
          </div>
        )}
        <div className="field">
          <label>Язык</label>
          <select
            value={langCode}
            onChange={(e) => setLangCode(e.target.value)}
            disabled={busy}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        {isDesktop && (
          <label className="toggle" title="Жадное декодирование: быстрее ~2× почти без потерь на чистой речи (лекции, вебинары)">
            <input
              type="checkbox"
              checked={fast}
              onChange={(e) => setFast(e.target.checked)}
              disabled={busy}
            />
            <span>🚀 Быстрый режим</span>
          </label>
        )}
        <div className="badge">
          {isDesktop
            ? '⚡ Metal · Apple Silicon'
            : hasWebGPU === null
              ? 'Проверка GPU…'
              : hasWebGPU
                ? '⚡ WebGPU доступен'
                : '🐢 WebGPU нет — режим CPU'}
        </div>
      </section>

      <section
        className="dropzone"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <p>Перетащи файл сюда или</p>
        <div className="actions">
          {isDesktop ? (
            <button
              className={`btn primary ${busy ? 'disabled' : ''}`}
              onClick={pickFile}
              disabled={busy}
            >
              Выбрать файл
            </button>
          ) : (
            <label className={`btn primary ${busy ? 'disabled' : ''}`}>
              Выбрать файл
              <input
                type="file"
                accept="audio/*,video/*"
                onChange={onFileInput}
                disabled={busy}
                hidden
              />
            </label>
          )}
          <button
            className={`btn ${recording ? 'rec' : ''}`}
            onClick={toggleRecording}
            disabled={busy && !recording}
          >
            {recording ? '⏹ Остановить запись' : '🎤 Записать с микрофона'}
          </button>
          {isDesktop && (
            <button className="btn" onClick={pickFolder} disabled={busy}>
              📚 Папка курса → MD
            </button>
          )}
        </div>
        <p className="hint">mp3, wav, m4a, ogg, mp4, mov и другие форматы</p>
      </section>

      {busy && (
        <section className="progress">
          <div className="spinner" />
          <div className="progress-info">
            <div className="status">
              {status} {fileName && <span className="muted">· {fileName}</span>}
            </div>
            {course && (
              <div className="bar">
                <div
                  className="bar-fill"
                  style={{ width: `${(course.index / course.total) * 100}%` }}
                />
                <span className="bar-label">
                  Файл {course.index} из {course.total}
                </span>
              </div>
            )}
            {!isDesktop && progress.active && progress.overall < 100 && (
              <div className="bar">
                <div
                  className="bar-fill"
                  style={{ width: `${progress.overall}%` }}
                />
                <span className="bar-label">
                  Загрузка модели {Math.round(progress.overall)}%
                </span>
              </div>
            )}
            {pct !== null && pct < 100 && (
              <div className="bar">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
                <span className="bar-label">Распознавание {pct}%</span>
              </div>
            )}
            <div className="muted small">прошло {formatTime(elapsed)}</div>
          </div>
        </section>
      )}

      {busy && partial && (
        <section className="result live">
          <div className="result-head">
            <h2>Распознаётся…</h2>
            <span className="muted small">текст появляется в реальном времени</span>
          </div>
          <p className="plain">
            {partial}
            <span className="caret" />
          </p>
        </section>
      )}

      {phase === 'error' && (
        <>
          <section className="error">⚠️ {error}</section>
          {partial.trim() && (
            <section className="result">
              <div className="result-head">
                <h2>Распознано до обрыва</h2>
                <div className="export">
                  <button
                    className="btn"
                    onClick={() => navigator.clipboard.writeText(partial.trim())}
                  >
                    📋 Копировать
                  </button>
                  <button
                    className="btn"
                    onClick={() => saveText('transcript.txt', partial.trim())}
                  >
                    ⬇ TXT
                  </button>
                </div>
              </div>
              <p className="plain">{partial.trim()}</p>
            </section>
          )}
        </>
      )}

      {phase === 'done' && final && (
        <section className="result">
          <div className="result-head">
            <h2>Результат</h2>
            <div className="export">
              <button
                className="btn"
                onClick={() => navigator.clipboard.writeText(plainText)}
              >
                📋 Копировать
              </button>
              <button
                className="btn"
                onClick={() => saveText('transcript.txt', plainText)}
              >
                ⬇ TXT
              </button>
              {final.srt && (
                <button
                  className="btn"
                  onClick={() => saveText('transcript.srt', final.srt)}
                >
                  ⬇ SRT
                </button>
              )}
            </div>
          </div>

          {final.mdPath && (
            <div className="saved-note">
              ✓ Документ курса сохранён · файлов: {final.fileCount}
              {final.failed ? ` · не распознано: ${final.failed}` : ''}
              <button
                className="link-btn"
                onClick={() => desktop!.openPath(final.mdPath!)}
              >
                Открыть .md
              </button>
              <button
                className="link-btn"
                onClick={() => desktop!.reveal(final.mdPath!)}
              >
                Показать в Finder
              </button>
            </div>
          )}

          {final.savedPath && (
            <div className="saved-note">
              ✓ TXT сохранён в Загрузки
              <button
                className="link-btn"
                onClick={() => desktop!.reveal(final.savedPath!)}
              >
                Показать в Finder
              </button>
            </div>
          )}

          {final.recordingPath && (
            <div className="saved-note">
              🎙️ Запись сохранена в «Документы/Транскрибер»
              <button
                className="link-btn"
                onClick={() => desktop!.reveal(final.recordingPath!)}
              >
                Показать в Finder
              </button>
            </div>
          )}

          {segments.length > 0 ? (
            <div className="segments">
              {segments.map((c, i) => (
                <div className="segment" key={i}>
                  <span className="ts">{formatTime(c.timestamp[0] ?? 0)}</span>
                  <span className="seg-text">{c.text.trim()}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="plain">{plainText}</p>
          )}
        </section>
      )}

      <footer>
        {isDesktop && (
          <div className="footer-actions">
            <button className="link-btn" onClick={() => desktop!.openRecordings()}>
              📂 Папка записей
            </button>
          </div>
        )}
        {isDesktop
          ? 'whisper.cpp · Metal · модель Whisper large-v3-turbo от OpenAI'
          : 'transformers.js · модели Whisper от OpenAI'}
      </footer>
    </div>
  )
}
