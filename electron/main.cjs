const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  systemPreferences,
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
    const ff = spawn(findFfmpeg(), [
      '-y', '-i', input, '-c:a', 'aac', '-b:a', '128k', outFile,
    ])
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
    const ff = spawn(findFfmpeg(), [
      '-y', '-i', input,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      outWav,
    ])
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

ipcMain.handle('open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('open-path', async (_e, p) => {
  if (p && fs.existsSync(p)) await shell.openPath(p)
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
    if (fast) args.push('-bs', '1', '-bo', '1', '-nf')
    const cp = spawn(WHISPER, args)
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
      if (code !== 0)
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
    return await runWhisper(wav, language, tmp, onSegment, onProgress, fast)
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}


ipcMain.handle('transcribe', async (e, payload) => {
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
    const { text, srt } = await transcribeInput(
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

    return { text, srt, savedPath, recordingPath }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
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

  for (let i = 0; i < total; i++) {
    const abs = files[i]
    const rel = path.relative(dir, abs)
    e.sender.send('status', `Файл ${i + 1}/${total} · ${rel}`)
    e.sender.send('partial', '')
    e.sender.send('progress', 0)
    e.sender.send('course-progress', { index: i + 1, total, name: rel })
    try {
      const r = await transcribeInput(
        abs,
        language,
        (acc) => e.sender.send('partial', acc),
        (pct) => e.sender.send('progress', pct),
        fast,
      )
      results.set(abs, r)
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
  return { md, mdPath, fileCount: total, failed }
})
