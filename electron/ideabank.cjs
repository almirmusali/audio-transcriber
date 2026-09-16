'use strict'
// Отправка расшифровки в «Банк идей» (~/Code/idea-bank).
//
// Банк сам решает, что это — идея, сценарий или инструкция, — и раскладывает по
// разделам. Отвечает сразу, разбор идёт у него фоном. Слушает 8771 на студии;
// с ноутбука достаём его через Tailscale.
//
// Вместе с текстом отправляем и само аудио: тогда в банке у идеи будет плеер и
// длительность, как у голосового из телеграма.
const fs = require('fs')
const path = require('path')
const URLS = [
  process.env.IDEABANK_URL,
  'http://127.0.0.1:8771',
  'http://mac-studio.tail667b0c.ts.net:8771',
].filter(Boolean)

// Аудио бывает на час — многовато для одного запроса, но банк локальный.
const MAX_AUDIO_BYTES = 200 * 1024 * 1024

function audioForm(text, audioPath) {
  const form = new FormData()
  form.append('text', text)
  form.append('source', 'транскрибер')
  try {
    const stat = fs.statSync(audioPath)
    if (stat.size > MAX_AUDIO_BYTES) return null
    form.append('audio', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath))
    return form
  } catch {
    return null            // файл исчез или не читается — уйдёт один текст
  }
}

async function sendToBank(text, audioPath) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('Нет текста для идеи')
  const form = audioPath ? audioForm(clean, audioPath) : null
  const request = form
    ? { body: form }        // FormData сам проставит content-type с границей
    : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: clean, source: 'транскрибер' }),
      }

  let lastErr = null
  for (const base of URLS) {
    try {
      const res = await fetch(base + '/api/inbox', {
        method: 'POST',
        ...request,
        // с аудио запрос дольше: пока файл льётся, банк молчит
        signal: AbortSignal.timeout(form ? 120000 : 10000),
      })
      if (!res.ok) throw new Error(`банк ответил ${res.status}`)
      await res.json().catch(() => ({}))
      // Ссылку даём на адрес, который только что ответил: он точно доступен
      // с этой машины — в отличие от localhost из настроек банка.
      return { url: base }
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    'Банк идей недоступен (' + (lastErr?.message || 'нет ответа') + '). Запусти его на :8771.',
  )
}

module.exports = { URLS, sendToBank }
