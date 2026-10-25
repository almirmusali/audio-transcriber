'use strict'
// «Совещание в Орбиту»: расшифровка с таймкодами и запись уходят в Орбиту (~/Code/orbita),
// там из них собирается саммари на одну-две страницы, сверенное с расшифровкой.
//
// Функция личная и по умолчанию выключена, как «Банк идей»: кнопка появляется, только если
// адрес Орбиты задан в ORBITA_URL или строками в ~/.config/transcriber/orbita-url
// (приложение из Finder переменных окружения не видит). Адресов может быть несколько —
// пробуем по порядку: на студии отвечает 127.0.0.1, с макбука — адрес в tailnet.
//
// Порядок такой: сначала текст — Орбита сразу садится за саммари; потом аудио. Аудио
// перед отправкой ужимаем в m4a 64k моно: час разговора ≈ 30 МБ, а исходником может быть видео.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const CONFIG_FILE = path.join(os.homedir(), '.config', 'transcriber', 'orbita-url')

function orbitaUrls() {
  let fromFile = []
  try {
    fromFile = fs.readFileSync(CONFIG_FILE, 'utf8').split(/\r?\n/)
  } catch {}
  return [process.env.ORBITA_URL, ...fromFile]
    .map((u) => String(u || '').trim().replace(/\/+$/, ''))
    .filter((u) => /^https?:\/\//.test(u))
}

function squeeze(ffmpeg, input, out) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpeg, [
      '-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out,
    ])
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('error', reject)
    ff.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error('ffmpeg: ' + err.slice(-200))),
    )
  })
}

async function postJson(url, body, ms) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Орбита ответила ${res.status}`)
  return data
}

// Проекты Орбиты для выбора, куда положить совещание: живые (без «брошен» и «готово»),
// сначала активные, внутри — по последнему касанию.
const STATUS_ORDER = ['active', 'inbox', 'idea', 'task', 'paused']
async function listProjects() {
  let lastErr = null
  for (const u of orbitaUrls()) {
    try {
      const res = await fetch(u + '/api/state', { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`Орбита ответила ${res.status}`)
      const st = await res.json()
      return (st.projects || [])
        .filter((p) => STATUS_ORDER.includes(p.status))
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
            (b.touchedAt || b.updatedAt || 0) - (a.touchedAt || a.updatedAt || 0),
        )
        .map((p) => ({ id: p.id, name: p.name, emoji: p.emoji || '', status: p.status, kind: p.kind }))
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error('Орбита недоступна (' + (lastErr?.message || 'не настроена') + ').')
}

// payload: { text, segments: [{start, end, text, speaker?}], durationSec, at, audioPath, projectId? }
async function sendMeeting(payload, ffmpeg) {
  const text = String(payload?.text || '').trim()
  if (!text) throw new Error('Нет текста совещания')
  const urls = orbitaUrls()
  if (!urls.length) throw new Error('Орбита не настроена: адрес в ' + CONFIG_FILE)

  let base = null
  let id = null
  let lastErr = null
  for (const u of urls) {
    try {
      const r = await postJson(u + '/api/meetings', {
        text,
        segments: payload.segments || [],
        durationSec: payload.durationSec || 0,
        at: payload.at || Date.now(),
        projectId: payload.projectId || null,
        source: 'транскрибер',
      }, 30000)
      base = u
      id = r.id
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!id) throw new Error('Орбита недоступна (' + (lastErr?.message || 'нет ответа') + ').')

  // Ссылку даём на адрес, который только что ответил: он точно открывается с этой машины.
  const result = { url: `${base}/#/m/${id}`, audioError: null }
  const src = payload.audioPath
  if (!src || !fs.existsSync(src)) return result

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-'))
  try {
    const m4a = await squeeze(ffmpeg, src, path.join(tmp, 'meeting.m4a'))
    const res = await fetch(`${base}/api/meetings/${id}/audio`, {
      method: 'PUT',
      headers: { 'content-type': 'audio/mp4' },
      body: fs.readFileSync(m4a),
      // пока файл льётся по tailnet, Орбита молчит
      signal: AbortSignal.timeout(15 * 60 * 1000),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `Орбита ответила ${res.status}`)
    }
  } catch (err) {
    // текст уже в Орбите и саммари пишется — без записи совещание всё равно полезно
    result.audioError = err?.message || String(err)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return result
}

module.exports = { orbitaUrls, sendMeeting, listProjects }
