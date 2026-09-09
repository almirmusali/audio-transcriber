'use strict'
// Отправка расшифровки в «Банк идей» (~/Code/idea-bank).
//
// Банк сам разбирает текст на идеи — он отвечает сразу, разбор идёт у него
// фоном. Слушает 8771 на студии; с ноутбука достаём его через Tailscale.
const URLS = [
  process.env.IDEABANK_URL,
  'http://127.0.0.1:8771',
  'http://mac-studio.tail667b0c.ts.net:8771',
].filter(Boolean)

async function sendToBank(text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('Нет текста для идеи')
  const body = JSON.stringify({ text: clean, source: 'транскрибер' })

  let lastErr = null
  for (const base of URLS) {
    try {
      const res = await fetch(base + '/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000),
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
