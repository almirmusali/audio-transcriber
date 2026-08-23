#!/usr/bin/env node
// Веб-версия «Транскрибера» для телефона: iPhone пишет/шлёт аудио,
// распознаёт mac-studio (whisper.cpp + Metal), текст возвращается по SSE.
// Зависимостей нет — только стандартная библиотека Node.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.join(HERE, '..')
const PUBLIC = path.join(HERE, 'public')

const PORT = Number(process.env.PORT || 8773)
const HOST = process.env.HOST || '127.0.0.1'
const DATA =
  process.env.TRANSCRIBER_DATA ||
  path.join(os.homedir(), 'Documents', 'Транскрибер', 'Телефон')
const HISTORY_LIMIT = 50

// ---------- бинарники и модель ----------
// Свои resources/, иначе — из установленного .app (там они точно есть).
const APP_RES = '/Applications/Транскрибер.app/Contents/Resources'
function pick(...cands) {
  for (const c of cands) if (c && fs.existsSync(c)) return c
  return null
}
const WHISPER = pick(
  process.env.WHISPER_BIN,
  path.join(PROJECT, 'resources', 'bin', 'whisper-cli'),
  path.join(APP_RES, 'bin', 'whisper-cli'),
)
const FFMPEG = pick(
  process.env.FFMPEG_BIN,
  path.join(PROJECT, 'resources', 'bin', 'ffmpeg'),
  path.join(APP_RES, 'bin', 'ffmpeg'),
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
)
const MODEL = pick(
  process.env.WHISPER_MODEL,
  path.join(PROJECT, 'resources', 'models', 'ggml-large-v3-turbo-q5_0.bin'),
  path.join(APP_RES, 'models', 'ggml-large-v3-turbo-q5_0.bin'),
)
const CLAUDE = pick(
  process.env.CLAUDE_BIN,
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
)
for (const [name, val] of [['whisper-cli', WHISPER], ['ffmpeg', FFMPEG], ['модель', MODEL]]) {
  if (!val) {
    console.error(`Не найден ${name}. Запусти npm run setup или установи Транскрибер.app`)
    process.exit(1)
  }
}
fs.mkdirSync(DATA, { recursive: true })

// ---------- задания ----------
/** @type {Map<string, any>} */
const JOBS = new Map()
const CLIENTS = new Map() // jobId -> Set<res>
const QUEUE = []
let RUNNING = null // { id, procs:Set }

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
const jobDir = (id) => path.join(DATA, id)

function publicJob(j) {
  const { procs, ...rest } = j
  return rest
}

function saveMeta(j) {
  try {
    fs.writeFileSync(path.join(jobDir(j.id), 'meta.json'), JSON.stringify(publicJob(j), null, 2))
  } catch {
    /* не критично */
  }
}

function emit(j, event, data) {
  const set = CLIENTS.get(j.id)
  if (!set) return
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of set) {
    try {
      res.write(chunk)
    } catch {
      /* клиент отвалился */
    }
  }
}

function setStatus(j, status, extra = {}) {
  Object.assign(j, { status }, extra)
  emit(j, 'state', publicJob(j))
  saveMeta(j)
}

// ---------- внешние процессы ----------
function run(job, bin, args, { onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(bin, args)
    job.procs.add(cp)
    let errTail = ''
    cp.stdout.on('data', (d) => onStdout && onStdout(d.toString()))
    cp.stderr.on('data', (d) => {
      const s = d.toString()
      errTail = (errTail + s).slice(-2000)
      onStderr && onStderr(s)
    })
    cp.on('error', (e) => {
      job.procs.delete(cp)
      reject(e)
    })
    cp.on('close', (code) => {
      job.procs.delete(cp)
      if (code === 0 || job.cancelled) resolve()
      else reject(new Error(`${path.basename(bin)} (${code}): ${errTail.slice(-400)}`))
    })
  })
}

const TS_LINE = /\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)/

function wavSeconds(wav) {
  try {
    return Math.max(0, (fs.statSync(wav).size - 44) / 2 / 16000)
  } catch {
    return 0
  }
}

async function process_(j) {
  const dir = jobDir(j.id)
  const wav = path.join(dir, 'audio.wav')
  const outPrefix = path.join(dir, 'out')

  setStatus(j, 'converting')
  await run(j, FFMPEG, ['-y', '-i', j.sourceFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
  if (j.cancelled) return
  j.seconds = wavSeconds(wav)

  setStatus(j, 'recognizing', { progress: 0 })
  const args = ['-m', MODEL, '-f', wav, '-l', j.lang || 'auto', '-otxt', '-osrt', '-of', outPrefix, '-pp']
  if (j.fast) args.push('-bs', '1', '-bo', '1', '-nf')

  let acc = ''
  let lastEmit = 0
  await run(j, WHISPER, args, {
    onStdout: (chunk) => {
      for (const line of chunk.split('\n')) {
        const m = line.match(TS_LINE)
        if (m && m[1].trim()) {
          acc += (acc ? '\n' : '') + m[1].trim()
          j.partial = acc
          emit(j, 'partial', acc)
        }
      }
    },
    onStderr: (chunk) => {
      const m = chunk.match(/progress\s*=\s*(\d+)%/)
      if (m) {
        const pct = parseInt(m[1], 10)
        if (pct !== j.progress) {
          j.progress = pct
          const now = Date.now()
          if (now - lastEmit > 300 || pct === 100) {
            lastEmit = now
            emit(j, 'progress', pct)
          }
        }
      }
    },
  })

  const txtFile = outPrefix + '.txt'
  const srtFile = outPrefix + '.srt'
  j.text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8').trim() : acc
  j.srt = fs.existsSync(srtFile) ? fs.readFileSync(srtFile, 'utf8') : ''
  j.chars = j.text.length
  try {
    fs.rmSync(wav, { force: true })
  } catch {
    /* ignore */
  }
}

async function pump() {
  if (RUNNING || QUEUE.length === 0) return
  const j = JOBS.get(QUEUE.shift())
  if (!j || j.cancelled) return pump()
  RUNNING = j
  try {
    await process_(j)
    if (j.cancelled) {
      setStatus(j, 'cancelled', { finishedAt: Date.now() })
      emit(j, 'done', publicJob(j))
    } else {
      setStatus(j, 'done', { progress: 100, finishedAt: Date.now() })
      emit(j, 'done', publicJob(j))
    }
  } catch (err) {
    setStatus(j, 'error', { error: err.message || String(err), finishedAt: Date.now() })
    emit(j, 'done', publicJob(j))
  } finally {
    RUNNING = null
    for (const res of CLIENTS.get(j.id) || []) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    CLIENTS.delete(j.id)
    setImmediate(pump)
  }
}

function queuePosition(id) {
  const i = QUEUE.indexOf(id)
  return i < 0 ? 0 : i + 1
}

// ---------- история ----------
function loadHistory() {
  let dirs = []
  try {
    dirs = fs.readdirSync(DATA).filter((d) => fs.existsSync(path.join(DATA, d, 'meta.json')))
  } catch {
    return
  }
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, d, 'meta.json'), 'utf8'))
      // Задания, оборванные перезапуском сервера, не воскрешаем.
      if (j.status !== 'done' && j.status !== 'error') j.status = 'cancelled'
      j.procs = new Set()
      JOBS.set(j.id, j)
    } catch {
      /* битая мета — пропускаем */
    }
  }
  prune()
}

function prune() {
  const finished = [...JOBS.values()]
    .filter((j) => j.finishedAt)
    .sort((a, b) => b.createdAt - a.createdAt)
  for (const j of finished.slice(HISTORY_LIMIT)) {
    JOBS.delete(j.id)
    try {
      fs.rmSync(jobDir(j.id), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8',
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1))
  const file = path.join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('404')
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

function extFor(name) {
  const e = path.extname(name || '').toLowerCase()
  return /^\.[a-z0-9]{1,5}$/.test(e) ? e : '.bin'
}

function createJob(req, res, query) {
  const id = crypto.randomUUID().slice(0, 8) + '-' + Date.now().toString(36)
  const dir = jobDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const rawName = (query.get('name') || '').trim()
  const fromMic = query.get('mic') === '1'
  const name = rawName || `Запись ${stamp()}`
  const sourceFile = path.join(dir, 'source' + extFor(rawName || (fromMic ? '.m4a' : '.bin')))

  const out = fs.createWriteStream(sourceFile)
  let bytes = 0
  req.on('data', (d) => (bytes += d.length))
  req.pipe(out)
  req.on('aborted', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  out.on('finish', () => {
    if (bytes === 0) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      return sendJson(res, 400, { error: 'Пустой файл' })
    }
    const j = {
      id,
      name,
      fromMic,
      lang: query.get('lang') || 'auto',
      fast: query.get('fast') === '1',
      status: 'queued',
      progress: 0,
      partial: '',
      text: '',
      srt: '',
      seconds: 0,
      chars: 0,
      bytes,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      sourceFile,
      cancelled: false,
      procs: new Set(),
    }
    JOBS.set(id, j)
    saveMeta(j)
    QUEUE.push(id)
    pump()
    sendJson(res, 200, { id, queue: queuePosition(id) })
  })
  out.on('error', (e) => sendJson(res, 500, { error: e.message }))
}

function streamEvents(req, res, j) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': ok\n\n')
  res.write(`event: state\ndata: ${JSON.stringify({ ...publicJob(j), queue: queuePosition(j.id) })}\n\n`)
  if (j.partial) res.write(`event: partial\ndata: ${JSON.stringify(j.partial)}\n\n`)
  if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
    res.write(`event: done\ndata: ${JSON.stringify(publicJob(j))}\n\n`)
    return res.end()
  }
  if (!CLIENTS.has(j.id)) CLIENTS.set(j.id, new Set())
  CLIENTS.get(j.id).add(res)
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* ignore */
    }
  }, 15000)
  req.on('close', () => {
    clearInterval(ping)
    CLIENTS.get(j.id)?.delete(res)
  })
}

function cancelJob(j) {
  j.cancelled = true
  const i = QUEUE.indexOf(j.id)
  if (i >= 0) QUEUE.splice(i, 1)
  for (const cp of j.procs) {
    try {
      cp.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  if (j.status === 'queued') setStatus(j, 'cancelled', { finishedAt: Date.now() })
}

// Постобработка текста локальным Claude CLI (подписка, не API-ключ).
function aiProcess(j, preset) {
  const PROMPTS = {
    clean:
      'Отредактируй транскрипт: убери слова-паразиты и повторы, расставь знаки препинания и абзацы, сохрани смысл и стиль. Верни только готовый текст.',
    summary:
      'Сделай краткое резюме транскрипта: 3–7 пунктов главного и список конкретных действий, если они есть. Верни только результат.',
    post:
      'Преврати транскрипт в связный пост: заголовок, чёткая структура, живой язык, без воды. Верни только текст поста.',
  }
  const prompt = PROMPTS[preset] || PROMPTS.clean
  return new Promise((resolve, reject) => {
    if (!CLAUDE) return reject(new Error('claude CLI не найден'))
    // stdio[0]='ignore': без этого claude ждёт данные на stdin и падает по таймауту.
    const cp = spawn(CLAUDE, ['-p', `${prompt}\n\n=== ТРАНСКРИПТ ===\n${j.text}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.dirname(CLAUDE)}:${process.env.PATH || ''}:/usr/bin:/bin` },
    })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', reject)
    cp.on('close', (code) =>
      code === 0 && out.trim()
        ? resolve(out.trim())
        : reject(new Error((err || out).trim().slice(-300) || `claude (${code})`)),
    )
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      model: path.basename(MODEL),
      ai: !!CLAUDE,
      running: RUNNING ? RUNNING.id : null,
      queue: QUEUE.length,
    })
  }

  if (p === '/api/jobs' && req.method === 'POST') return createJob(req, res, url.searchParams)

  if (p === '/api/history') {
    const items = [...JOBS.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, HISTORY_LIMIT)
      .map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        seconds: j.seconds,
        chars: j.chars,
        createdAt: j.createdAt,
        preview: (j.text || j.partial || '').slice(0, 120),
      }))
    return sendJson(res, 200, { items })
  }

  const m = p.match(/^\/api\/jobs\/([\w-]+)(\/[a-z]+)?$/)
  if (m) {
    const j = JOBS.get(m[1])
    if (!j) return sendJson(res, 404, { error: 'Задание не найдено' })
    const sub = m[2]
    if (!sub && req.method === 'GET')
      return sendJson(res, 200, { ...publicJob(j), queue: queuePosition(j.id) })
    if (!sub && req.method === 'DELETE') {
      cancelJob(j)
      JOBS.delete(j.id)
      try {
        fs.rmSync(jobDir(j.id), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      return sendJson(res, 200, { ok: true })
    }
    if (sub === '/events') return streamEvents(req, res, j)
    if (sub === '/cancel') {
      cancelJob(j)
      return sendJson(res, 200, { ok: true })
    }
    if (sub === '/txt' || sub === '/srt') {
      const body = sub === '/txt' ? j.text : j.srt
      const ext = sub.slice(1)
      const fname = encodeURIComponent(j.name.replace(/\.[^.]+$/, '') + '.' + ext)
      res.writeHead(200, {
        'content-type': MIME['.' + ext],
        'content-disposition': `attachment; filename*=UTF-8''${fname}`,
      })
      return res.end(body)
    }
    if (sub === '/audio') {
      if (!fs.existsSync(j.sourceFile)) return sendJson(res, 404, { error: 'Нет аудио' })
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return fs.createReadStream(j.sourceFile).pipe(res)
    }
    if (sub === '/ai' && req.method === 'POST') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', async () => {
        const preset = (() => {
          try {
            return JSON.parse(body).preset
          } catch {
            return 'clean'
          }
        })()
        try {
          const text = await aiProcess(j, preset)
          sendJson(res, 200, { text })
        } catch (e) {
          sendJson(res, 500, { error: e.message || String(e) })
        }
      })
      return
    }
    return sendJson(res, 404, { error: 'Неизвестный метод' })
  }

  if (req.method === 'GET') return serveStatic(res, p)
  res.writeHead(405)
  res.end()
})

server.requestTimeout = 0
server.headersTimeout = 0
server.timeout = 0

loadHistory()
server.listen(PORT, HOST, () => {
  console.log(`Транскрибер (веб) на http://${HOST}:${PORT}`)
  console.log(`Модель: ${MODEL}`)
  console.log(`Данные: ${DATA}`)
})
