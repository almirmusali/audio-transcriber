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

const isDev = !app.isPackaged
const DEV_URL = 'http://localhost:5180'

function resourcePath(...p) {
  return isDev
    ? path.join(__dirname, '..', 'resources', ...p)
    : path.join(process.resourcesPath, ...p)
}

const MODEL = resourcePath('models', 'ggml-large-v3-turbo-q5_0.bin')
const WHISPER = resourcePath('bin', 'whisper-cli')

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
    filters: [
      {
        name: 'Аудио и видео',
        extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac',
          'mp4', 'mov', 'm4v', 'webm', 'mkv', 'wma', 'aiff', 'aif'],
      },
    ],
  })
  return r.canceled ? null : r.filePaths[0]
})

// Строка таймкода в выводе whisper-cli: [00:00:00.000 --> 00:00:05.000]   текст
const TS = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)/

ipcMain.handle('transcribe', async (e, payload) => {
  const language = payload.language && payload.language !== '' ? payload.language : 'auto'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-'))
  try {
    let input = payload.path
    if (!input && payload.bytes) {
      input = path.join(tmp, payload.name || 'audio.bin')
      fs.writeFileSync(input, Buffer.from(payload.bytes))
    }
    if (!input) throw new Error('Нет входного файла')

    e.sender.send('status', 'Конвертация аудио…')
    const wav = path.join(tmp, 'audio.wav')
    await toWav(input, wav)

    e.sender.send('status', 'Распознавание речи…')
    const outPrefix = path.join(tmp, 'out')
    const args = [
      '-m', MODEL,
      '-f', wav,
      '-l', language,
      '-otxt', '-osrt',
      '-of', outPrefix,
      '-pp',
    ]

    const streamed = await new Promise((resolve, reject) => {
      const cp = spawn(WHISPER, args)
      let acc = ''
      let stderr = ''
      cp.stdout.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const m = line.match(TS)
          if (m && m[1].trim()) {
            acc += (acc ? '\n' : '') + m[1].trim()
            e.sender.send('partial', acc)
          }
        }
      })
      cp.stderr.on('data', (d) => {
        stderr += d
        const ms = d.toString().match(/progress\s*=\s*(\d+)%/)
        if (ms) e.sender.send('progress', parseInt(ms[1], 10))
      })
      cp.on('error', reject)
      cp.on('close', (code) =>
        code === 0
          ? resolve(acc)
          : reject(new Error('whisper-cli (' + code + '): ' + stderr.slice(-500))),
      )
    })

    const txtFile = outPrefix + '.txt'
    const srtFile = outPrefix + '.srt'
    const text = fs.existsSync(txtFile)
      ? fs.readFileSync(txtFile, 'utf8').trim()
      : streamed
    const srt = fs.existsSync(srtFile) ? fs.readFileSync(srtFile, 'utf8') : ''

    // Авто-сохранение TXT в Загрузки (аналог авто-скачивания в браузере).
    let savedPath = null
    try {
      const base =
        (payload.name || path.basename(input)).replace(/\.[^.]+$/, '') ||
        'transcript'
      savedPath = path.join(app.getPath('downloads'), base + '.txt')
      fs.writeFileSync(savedPath, text, 'utf8')
    } catch {
      /* не критично */
    }

    return { text, srt, savedPath }
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
