'use strict'
// Имя файла по смыслу расшифровки.
//
// Спрашиваем Sonnet, о чём запись, по её началу — модели хватает первых строк,
// а на длинной лекции это не стоит ни времени, ни денег. Сначала пробуем
// локальный claude CLI (работает на подписке), потом — API-ключ из панели ИИ.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

// Сколько символов расшифровки показываем модели.
const HEAD_CHARS = 100

const CLAUDE_BIN = [
  process.env.CLAUDE_BIN,
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
].find((p) => p && fs.existsSync(p))

function buildPrompt(text) {
  const head = String(text || '').trim().slice(0, HEAD_CHARS)
  if (!head) return null
  return (
    'Это начало расшифровки аудиозаписи. Придумай короткое имя файла по смыслу: ' +
    'о чём речь, 2–5 слов, на языке записи, без расширения, без кавычек и точки в конце. ' +
    'Ответь только именем.\n\n---\n' +
    head
  )
}

// Из ответа модели делаем имя, которое macOS точно примет.
function sanitizeFileName(raw) {
  const name = String(raw || '')
    .split('\n')[0]
    .replace(/["'`«»]/g, '')
    .replace(/[\/\\:*?<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[ .-]+$/, '')
  return name || null
}

function runClaude(prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_BIN) return reject(new Error('claude CLI не найден'))
    // stdio[0]='ignore': иначе claude ждёт данные на stdin и висит до таймаута.
    const cp = spawn(CLAUDE_BIN, ['-p', prompt, '--model', model], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: os.tmpdir(), // чтобы CLI не подтягивал контекст случайного проекта
      env: {
        ...process.env,
        PATH: `${path.dirname(CLAUDE_BIN)}:${process.env.PATH || ''}:/usr/bin:/bin`,
      },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => cp.kill('SIGKILL'), timeoutMs)
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (err += d))
    cp.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    cp.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error((err || out).trim().slice(-300) || `claude (${code})`))
    })
  })
}

// Запасной путь: ключ Anthropic из панели ИИ, если у CLI истекла сессия.
async function askApi(prompt, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `Ошибка API (${res.status})`)
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
}

// Почему имя не подобралось — рендерер показывает это подсказкой. Молчаливый
// откат на transcript.txt выглядит как «фича не работает», и причину не найти.
function reasonFor(err) {
  const m = String(err && err.message).toLowerCase()
  if (m.includes('не найден')) return 'noCli'
  if (m.includes('not logged in') || m.includes('login') || m.includes('oauth')) return 'noLogin'
  return 'failed'
}

// { name, reason }: name — имя без расширения, либо null и причина отказа.
async function suggestName({ text, apiKey } = {}) {
  const prompt = buildPrompt(text)
  if (!prompt) return { name: null, reason: null }

  let reason = null
  try {
    return { name: sanitizeFileName(await runClaude(prompt, 'sonnet', 60000)), reason: null }
  } catch (err) {
    reason = reasonFor(err)
    console.warn('claude CLI не подобрал имя:', err.message)
  }
  if (!apiKey) return { name: null, reason }
  try {
    return { name: sanitizeFileName(await askApi(prompt, apiKey)), reason: null }
  } catch (err) {
    console.warn('API не подобрал имя:', err.message)
    return { name: null, reason: 'failed' }
  }
}

module.exports = { HEAD_CHARS, CLAUDE_BIN, buildPrompt, sanitizeFileName, suggestName }
