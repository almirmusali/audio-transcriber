// Личный словарь имён и терминов для whisper.
//
// Читает ~/.config/whisper/dictionary.txt (общий для всех проектов) и, если есть,
// whisper-dictionary.txt из корня проекта — термины проекта идут первыми.
// Возвращает готовую подсказку для whisper-cli (--prompt) — с ней распознавалка
// перестаёт коверкать имена проектов, инструментов и людей.
//
// Переменные окружения:
//   WHISPER_PROMPT     — готовый текст подсказки, минует словарь целиком
//   WHISPER_DICT       — путь к дополнительному файлу словаря
//   WHISPER_DICT_TOKENS — потолок подсказки в токенах (по умолчанию 200)
//   WHISPER_CARRY_PROMPT=0 — не повторять подсказку на каждом окне в 30 секунд
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const GLOBAL_FILE = path.join(os.homedir(), '.config', 'whisper', 'dictionary.txt')
const PROJECT_FILE = 'whisper-dictionary.txt'
const HEAD = 'Словарь имён и терминов: '

// Потолок подсказки. У whisper жёсткий лимит n_text_ctx/2 ≈ 224 токена, и лишнее
// он отрезает С НАЧАЛА, оставляя хвост: то есть молча выбрасывает ровно те термины,
// которые мы поставили первыми как самые важные. Поэтому режем сами и с запасом.
function tokenBudget() {
  const n = Number(process.env.WHISPER_DICT_TOKENS)
  return Number.isFinite(n) && n > 0 ? n : 200
}

// Грубая оценка длины в токенах: у мультиязычного словаря whisper кириллица
// дробится примерно вдвое мельче латиницы. Коэффициенты сняты с живого замера —
// обрезка кириллической подсказки начинается около 410 символов.
function estimateTokens(s) {
  let t = 0
  for (const ch of s) {
    if (/[\u0400-\u04FF]/.test(ch)) t += 0.55
    else if (/[0-9A-Za-z]/.test(ch)) t += 0.3
    else t += 0.5
  }
  return t
}

// Файлы словаря по убыванию важности: свой у проекта — раньше общего.
function dictionaryFiles(projectDir) {
  const list = []
  if (process.env.WHISPER_DICT) list.push(process.env.WHISPER_DICT)
  if (projectDir) list.push(path.join(projectDir, PROJECT_FILE))
  list.push(GLOBAL_FILE)
  return list
}

function readTerms(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const clean = line.split('#')[0].trim()
    if (!clean) continue
    for (const term of clean.split(',')) {
      const t = term.trim()
      if (t) out.push(t)
    }
  }
  return out
}

function terms(projectDir) {
  const seen = new Set()
  const out = []
  for (const file of dictionaryFiles(projectDir)) {
    for (const t of readTerms(file)) {
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(t)
    }
  }
  return out
}

// Подсказка плюс отчёт о том, что не влезло: тихая обрезка тут дороже всего,
// потому что выглядит как «словарь не работает».
function buildPrompt(projectDir) {
  const forced = (process.env.WHISPER_PROMPT || '').trim()
  if (forced) return { prompt: forced, used: [], dropped: [] }
  const budget = tokenBudget()
  const all = terms(projectDir)
  const used = []
  let s = ''
  for (const term of all) {
    const next = s ? s + ', ' + term : term
    if (estimateTokens(HEAD + next + '.') > budget) break
    s = next
    used.push(term)
  }
  return { prompt: s ? HEAD + s + '.' : '', used, dropped: all.slice(used.length) }
}

// Подсказка целиком. Пустая строка — словаря нет, подсказку не передаём.
function whisperPrompt(projectDir) {
  return buildPrompt(projectDir).prompt
}

// Готовые аргументы для whisper-cli. Пустой массив — словаря нет.
function promptArgs(projectDir) {
  const prompt = whisperPrompt(projectDir)
  if (!prompt) return []
  const args = ['--prompt', prompt]
  if (process.env.WHISPER_CARRY_PROMPT !== '0') args.push('--carry-initial-prompt')
  return args
}

// Общий словарь как текст — для экранов настроек.
function readGlobalDictionary() {
  try {
    return fs.readFileSync(GLOBAL_FILE, 'utf8')
  } catch {
    return ''
  }
}

function writeGlobalDictionary(text) {
  fs.mkdirSync(path.dirname(GLOBAL_FILE), { recursive: true })
  fs.writeFileSync(GLOBAL_FILE, String(text ?? ''), 'utf8')
  return GLOBAL_FILE
}

module.exports = {
  GLOBAL_FILE,
  buildPrompt,
  dictionaryFiles,
  terms,
  whisperPrompt,
  promptArgs,
  readGlobalDictionary,
  writeGlobalDictionary,
}
