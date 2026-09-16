const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  systemPreferences,
  clipboard,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const {
  MEDIA_EXT,
  buildTree,
  collectMedia,
  buildCourseMarkdown,
} = require('./course.cjs')
const { suggestName } = require('./ai-name.cjs')
const { bankUrls, sendToBank } = require('./ideabank.cjs')
const {
  GLOBAL_FILE: DICT_FILE,
  buildPrompt,
  promptArgs,
  readGlobalDictionary,
  writeGlobalDictionary,
} = require('./whisper-dict.cjs')

// Словарь длиннее лимита whisper — не молчим: тихо обрезанный словарь выглядит
// как «словарь не работает», и искать это потом дорого.
let dictWarned = false
function warnDictionaryOverflow(projectDir) {
  if (dictWarned) return
  dictWarned = true
  const { used, dropped } = buildPrompt(projectDir)
  if (!dropped.length) return
  console.warn(
    `whisper-словарь: влезло ${used.length} терминов, не влезло ${dropped.length} ` +
      `(начиная с «${dropped[0]}»). Убери лишнее из ~/.config/whisper/dictionary.txt — ` +
      'хвост списка whisper всё равно не увидит.'
  )
}

const isDev = !app.isPackaged
const DEV_URL = 'http://localhost:5180'

function resourcePath(...p) {
  return isDev
    ? path.join(__dirname, '..', 'resources', ...p)
    : path.join(process.resourcesPath, ...p)
}

const MODEL = resourcePath('models', 'ggml-large-v3-turbo-q5_0.bin')
const WHISPER = resourcePath('bin', 'whisper-cli')

// Папка для сохранения записей с микрофона.
function recordingsDir() {
  const dir = path.join(app.getPath('documents'), 'Транскрибер')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Метка времени для имени файла: 2026-07-02 14-30-15
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  )
}

// Конвертация записи в m4a (AAC) — компактный, открывается на Mac нативно.
function toM4a(input, outFile) {
  return new Promise((resolve, reject) => {
    const ff = track(spawn(findFfmpeg(), [
      '-y', '-i', input, '-c:a', 'aac', '-b:a', '128k', outFile,
    ]))
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('error', reject)
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg m4a: ' + err.slice(-300))),
    )
  })
}

function findFfmpeg() {
  const candidates = [
    resourcePath('bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return 'ffmpeg'
}

// Отмена: трекаем активные процессы (ffmpeg/whisper), чтобы уметь их убить.
let CANCELLED = false
const ACTIVE = new Set()
function track(cp) {
  ACTIVE.add(cp)
  const off = () => ACTIVE.delete(cp)
  cp.on('close', off)
  cp.on('error', off)
  return cp
}
function killActive() {
  for (const cp of ACTIVE) {
    try {
      cp.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  ACTIVE.clear()
}

// Длительность wav (16кГц, 16 бит, моно) по размеру файла, в секундах.
function wavSeconds(wav) {
  try {
    const size = fs.statSync(wav).size
    return Math.max(0, (size - 44) / 2 / 16000)
  } catch {
    return 0
  }
}

ipcMain.handle('cancel-transcribe', async () => {
  CANCELLED = true
  killActive()
})

let win
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 860,
    minWidth: 760,
    minHeight: 600,
    title: 'Транскрибер',
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (isDev) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.on('closed', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy()
    overlayWin = null
  })
}

app.whenReady().then(() => {
  // Разрешаем рендереру запрашивать микрофон (иначе Electron блокирует getUserMedia).
  const allow = ['media', 'audioCapture', 'microphone']
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) =>
    cb(allow.includes(perm)),
  )
  session.defaultSession.setPermissionCheckHandler((_wc, perm) =>
    allow.includes(perm),
  )

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Запрос доступа к микрофону на уровне macOS (TCC). Вызывается перед записью.
ipcMain.handle('request-mic', async () => {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status === 'denied') return 'denied'
  // 'not-determined' → показываем системный запрос
  const ok = await systemPreferences.askForMediaAccess('microphone')
  return ok ? true : 'denied'
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Конвертация любого аудио/видео в WAV 16кГц моно — формат для whisper.cpp.
function toWav(input, outWav) {
  return new Promise((resolve, reject) => {
    const ff = track(spawn(findFfmpeg(), [
      '-y', '-i', input,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      outWav,
    ]))
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('error', reject)
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.slice(-400))),
    )
  })
}

ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Аудио и видео', extensions: MEDIA_EXT }],
  })
  return r.canceled ? null : r.filePaths[0]
})

// Что бросили в окно: папку или файл (drag-and-drop не различает их сам).
ipcMain.handle('path-kind', async (_e, p) => {
  try {
    return fs.statSync(p).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
})

ipcMain.handle('open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('open-path', async (_e, p) => {
  if (p && fs.existsSync(p)) await shell.openPath(p)
})

// Копирование в буфер обмена — нативно (navigator.clipboard из file:// ненадёжен).
ipcMain.handle('copy-text', async (_e, text) => {
  clipboard.writeText(String(text ?? ''))
})

// ===== Плавающая плашка записи (always-on-top) =====
let overlayWin = null
function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin
  overlayWin = new BrowserWindow({
    width: 240,
    height: 60,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType: без него Electron делает процесс UIElement-приложением
  // (= app.dock.hide()), и иконка пропадает из дока на всё время сессии.
  overlayWin.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'))
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  return overlayWin
}

ipcMain.on('rec-show', () => {
  const w = createOverlay()
  try {
    const { screen } = require('electron')
    const wa = screen.getPrimaryDisplay().workArea
    w.setPosition(Math.round(wa.x + wa.width / 2 - 120), wa.y + 24)
  } catch {
    /* ignore */
  }
  w.showInactive()
})

ipcMain.on('rec-hide', () => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
})

ipcMain.on('rec-update', (_e, st) => {
  if (overlayWin && !overlayWin.isDestroyed())
    overlayWin.webContents.send('rec-state', st)
})

// Команда с плашки → в главное окно (togglePause / stop).
ipcMain.on('overlay-action', (_e, action) => {
  if (win && !win.isDestroyed()) win.webContents.send('overlay-command', action)
})

// Строка таймкода в выводе whisper-cli: [00:00:00.000 --> 00:00:05.000]   текст
const TS = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)/

// Прогоняет готовый wav через whisper-cli. onSegment(acc), onProgress(pct%).
// fast: жадное декодирование (-bs 1 -bo 1 -nf) — быстрее ~2× на чистой речи.
function runWhisper(wav, language, tmp, onSegment, onProgress, fast) {
  return new Promise((resolve, reject) => {
    const outPrefix = path.join(tmp, 'out')
    const args = [
      '-m', MODEL, '-f', wav, '-l', language,
      '-otxt', '-osrt', '-of', outPrefix, '-pp',
    ]
    // Личный словарь имён и терминов — whisper перестаёт коверкать
    // «Кайдзен», «Дэкси», «Notion» и прочее своё.
    warnDictionaryOverflow(path.join(__dirname, '..'))
    args.push(...promptArgs(path.join(__dirname, '..')))
    if (fast) args.push('-bs', '1', '-bo', '1', '-nf')
    const cp = track(spawn(WHISPER, args))
    let acc = ''
    let stderr = ''
    cp.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const m = line.match(TS)
        if (m && m[1].trim()) {
          acc += (acc ? '\n' : '') + m[1].trim()
          onSegment && onSegment(acc)
        }
      }
    })
    cp.stderr.on('data', (d) => {
      stderr += d
      const ms = d.toString().match(/progress\s*=\s*(\d+)%/)
      if (ms) onProgress && onProgress(parseInt(ms[1], 10))
    })
    cp.on('error', reject)
    cp.on('close', (code) => {
      // При отмене процесс убит — отдаём то, что успели распознать, без ошибки.
      if (code !== 0 && !CANCELLED)
        return reject(new Error('whisper-cli (' + code + '): ' + stderr.slice(-500)))
      const txtFile = outPrefix + '.txt'
      const srtFile = outPrefix + '.srt'
      const text = fs.existsSync(txtFile)
        ? fs.readFileSync(txtFile, 'utf8').trim()
        : acc
      const srt = fs.existsSync(srtFile) ? fs.readFileSync(srtFile, 'utf8') : ''
      resolve({ text, srt })
    })
  })
}

// Полный цикл для одного файла: конвертация в wav + распознавание.
async function transcribeInput(input, language, onSegment, onProgress, fast) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-'))
  try {
    const wav = path.join(tmp, 'audio.wav')
    await toWav(input, wav)
    const r = await runWhisper(wav, language, tmp, onSegment, onProgress, fast)
    return { ...r, seconds: wavSeconds(wav) }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}


ipcMain.handle('transcribe', async (e, payload) => {
  CANCELLED = false
  const language = payload.language && payload.language !== '' ? payload.language : 'auto'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-'))
  try {
    let input = payload.path
    let recordingPath = null
    if (!input && payload.bytes) {
      input = path.join(tmp, payload.name || 'audio.bin')
      fs.writeFileSync(input, Buffer.from(payload.bytes))
      // Это запись с микрофона — сохраняем её в отдельную папку сразу,
      // до распознавания, чтобы аудио не потерялось при обрыве.
      try {
        recordingPath = path.join(recordingsDir(), `Запись ${stamp()}.m4a`)
        await toM4a(input, recordingPath)
      } catch {
        recordingPath = null
      }
    }
    if (!input) throw new Error('Нет входного файла')

    // 'recognizing' — токен, рендерер сам локализует.
    e.sender.send('status', 'recognizing')
    const { text, srt, seconds } = await transcribeInput(
      input,
      language,
      (acc) => e.sender.send('partial', acc),
      (pct) => e.sender.send('progress', pct),
      !!payload.fast,
    )

    // Авто-сохранение TXT в Загрузки (аналог авто-скачивания в браузере).
    let savedPath = null
    try {
      // Для записи имя TXT совпадает с именем аудио (общая метка времени).
      const base = recordingPath
        ? path.basename(recordingPath).replace(/\.[^.]+$/, '')
        : (payload.name || path.basename(input)).replace(/\.[^.]+$/, '') ||
          'transcript'
      savedPath = path.join(app.getPath('downloads'), base + '.txt')
      fs.writeFileSync(savedPath, text, 'utf8')
    } catch {
      /* не критично */
    }

    return {
      text,
      srt,
      savedPath,
      recordingPath,
      // Аудио, которое разбирали: запись с микрофона или выбранный файл.
      // По нему «Банк идей» делает плеер у идеи.
      audioPath: recordingPath || payload.path || null,
      seconds,
      chars: text.length,
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// Личный словарь для whisper: общий файл на все проекты.
ipcMain.handle('dict-get', async () => ({
  text: readGlobalDictionary(),
  file: DICT_FILE,
}))

ipcMain.handle('dict-set', async (_e, text) => writeGlobalDictionary(text))

ipcMain.handle('dict-reveal', async () => {
  if (!fs.existsSync(DICT_FILE)) writeGlobalDictionary(readGlobalDictionary())
  shell.showItemInFolder(DICT_FILE)
})

// ===== Имя файла по смыслу и «Банк идей» =====
ipcMain.handle('suggest-name', async (_e, payload) => suggestName(payload || {}))

ipcMain.handle('idea-enabled', async () => bankUrls().length > 0)

ipcMain.handle('send-idea', async (_e, payload) =>
  typeof payload === 'string'
    ? sendToBank(payload)
    : sendToBank(payload?.text, payload?.audioPath),
)

ipcMain.handle('open-external', async (_e, url) => {
  if (/^https?:\/\//.test(String(url || ''))) await shell.openExternal(url)
})

ipcMain.handle('save-as', async (_e, defaultName, content) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, content, 'utf8')
  return r.filePath
})

ipcMain.handle('reveal', async (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p)
})

// Открыть папку с записями в Finder.
ipcMain.handle('open-recordings', async () => {
  await shell.openPath(recordingsDir())
})

// Распознаёт всю папку курса → единый .md с оглавлением.
ipcMain.handle('transcribe-course', async (e, payload) => {
  CANCELLED = false
  const dir = payload.dir
  const language =
    payload.language && payload.language !== '' ? payload.language : 'auto'
  if (!dir || !fs.existsSync(dir)) throw new Error('Папка не найдена')

  const tree = buildTree(dir)
  const files = collectMedia(tree)
  if (files.length === 0)
    throw new Error('В папке (и подпапках) не найдено аудио или видео файлов')

  const courseName = path.basename(dir)
  const total = files.length
  const fast = !!payload.fast
  const results = new Map()
  let totalSeconds = 0
  let totalChars = 0
  let done = 0

  for (let i = 0; i < total; i++) {
    if (CANCELLED) break
    const abs = files[i]
    const rel = path.relative(dir, abs)
    e.sender.send('status', `Файл ${i + 1}/${total} · ${rel}`)
    e.sender.send('partial', '')
    e.sender.send('progress', 0)
    e.sender.send('course-progress', {
      index: i + 1,
      total,
      name: rel,
      seconds: totalSeconds,
      chars: totalChars,
    })
    try {
      const r = await transcribeInput(
        abs,
        language,
        (acc) => e.sender.send('partial', acc),
        (pct) => e.sender.send('progress', pct),
        fast,
      )
      results.set(abs, r)
      totalSeconds += r.seconds || 0
      totalChars += (r.text || '').length
      done++
    } catch (err) {
      results.set(abs, { text: '', srt: '', error: err.message || String(err) })
    }
  }

  const md = buildCourseMarkdown(dir, courseName, tree, results)
  let mdPath = path.join(dir, `${courseName} — транскрипция.md`)
  try {
    fs.writeFileSync(mdPath, md, 'utf8')
  } catch {
    // папка недоступна для записи → сохраняем в Документы/Транскрибер
    mdPath = path.join(recordingsDir(), `${courseName} — транскрипция.md`)
    fs.writeFileSync(mdPath, md, 'utf8')
  }

  const failed = [...results.values()].filter((r) => r.error).length
  return {
    md,
    mdPath,
    fileCount: done,
    failed,
    seconds: totalSeconds,
    chars: totalChars,
    cancelled: CANCELLED,
  }
})

// AI-обработка транскрипта через Claude API (эндпоинт /v1/messages).
// Запрос идёт из main-процесса — нет проблем с CORS, ключ не светится в сети рендерера.
ipcMain.handle('ai-process', async (_e, payload) => {
  const { apiKey, model, prompt, text } = payload || {}
  if (!apiKey) throw new Error('Не указан API-ключ Anthropic')
  if (!text) throw new Error('Нет текста для обработки')

  let res
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-opus-5',
        max_tokens: 8000,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\n=== ТРАНСКРИПТ ===\n${text}`,
          },
        ],
      }),
    })
  } catch (err) {
    throw new Error('Сеть недоступна: ' + (err.message || String(err)))
  }

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.error?.message || `Ошибка API (${res.status})`)
  }
  if (data.stop_reason === 'refusal') {
    throw new Error('Запрос отклонён моделью по соображениям безопасности')
  }
  const out = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!out) throw new Error('Пустой ответ модели')
  return out
})
