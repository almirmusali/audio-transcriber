// Распознавание говорящих: кто когда говорил.
//
// sherpa-onnx (github.com/k2-fsa/sherpa-onnx, Apache-2.0) — готовый бинарник
// без Python и без токенов Hugging Face. Внутри две модели:
//   • pyannote segmentation-3.0 — где в записи речь и где сменился голос;
//   • WeSpeaker ResNet34 (VoxCeleb) — «отпечаток» голоса для кластеризации.
// Эмбеддинги TitaNet и 3D-Speaker проверены на русских подкастах и отброшены:
// три мужских голоса они дробят на 15–27 «спикеров», WeSpeaker находит три.
//
// Разметка идёт на CPU, whisper — на Metal, поэтому их гоняем параллельно.

const fs = require('node:fs')
const os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')

// Порог кластеризации (косинусное расстояние): меньше — больше спикеров.
// 0.5 на трёх похожих мужских голосах даёт ровно троих.
const CLUSTER_THRESHOLD = 0.5

// Потоки — по числу производительных ядер: на 5 минутах подкаста 4 потока —
// 47 с, 8 — 33 с, 12 (с энергоэффективными ядрами) — 100 с.
function threads() {
  try {
    const n = parseInt(execFileSync('sysctl', ['-n', 'hw.perflevel0.physicalcpu']).toString(), 10)
    if (n > 0) return Math.min(n, 12)
  } catch {
    /* не Apple Silicon */
  }
  return Math.max(1, Math.floor(os.cpus().length / 2))
}

// Строка вывода: «12.345 -- 17.890 speaker_01»
const TURN = /^\s*([\d.]+)\s+--\s+([\d.]+)\s+speaker_(\d+)/

// paths: { bin, segmentation, embedding }. track — чтобы отмена убивала процесс.
// Возвращает [{ start, end, speaker }] с номерами спикеров по порядку появления.
function diarize(wav, paths, track = (cp) => cp) {
  return new Promise((resolve, reject) => {
    for (const p of [paths.bin, paths.segmentation, paths.embedding])
      if (!fs.existsSync(p)) return reject(new Error('Нет файла для разметки говорящих: ' + p))
    const args = [
      `--segmentation.num-threads=${threads()}`,
      `--embedding.num-threads=${threads()}`,
      `--segmentation.pyannote-model=${paths.segmentation}`,
      `--embedding.model=${paths.embedding}`,
      `--clustering.cluster-threshold=${CLUSTER_THRESHOLD}`,
      wav,
    ]
    const cp = track(spawn(paths.bin, args))
    let out = ''
    cp.stdout.on('data', (d) => (out += d))
    cp.stderr.on('data', (d) => (out += d))
    cp.on('error', reject)
    cp.on('close', (code) => {
      if (code !== 0) return reject(new Error('Разметка говорящих (' + code + '): ' + out.slice(-300)))
      const turns = []
      for (const line of out.split('\n')) {
        const m = line.match(TURN)
        if (m) turns.push({ start: +m[1], end: +m[2], raw: +m[3] })
      }
      resolve(renumber(turns))
    })
  })
}

// speaker_07 из кластеризации ничего не значит — нумеруем 1, 2, 3 по первому слову.
function renumber(turns) {
  const map = new Map()
  return turns
    .sort((a, b) => a.start - b.start)
    .map((t) => {
      if (!map.has(t.raw)) map.set(t.raw, map.size + 1)
      return { start: t.start, end: t.end, speaker: map.get(t.raw) }
    })
}

// Реплики у pyannote перекрываются: длинная реплика ведущего (8–33 с) целиком
// накрывает короткие вставки гостя («Конечно», «Нет») — паузы короче
// min_duration_off он склеивает. Если считать просто по перекрытию, вставки
// тонут в длинной реплике. Поэтому раскладываем реплики в плоскую ленту:
// более короткая, вложенная реплика перекрывает объемлющую.
function flatten(turns) {
  const cuts = [...new Set(turns.flatMap((t) => [t.start, t.end]))].sort((a, b) => a - b)
  const flat = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]
    const b = cuts[i + 1]
    let best = null
    for (const t of turns)
      if (t.start <= a && t.end >= b && (!best || t.end - t.start < best.end - best.start)) best = t
    if (!best) continue
    const last = flat[flat.length - 1]
    if (last && last.speaker === best.speaker && last.end === a) last.end = b
    else flat.push({ start: a, end: b, speaker: best.speaker })
  }
  return flat
}

// Кто говорил больше всего внутри [start, end] (turns — плоская лента).
// Если отрезок попал в паузу между репликами — берём ближайшую реплику.
function speakerAt(turns, start, end) {
  const overlap = new Map()
  for (const t of turns) {
    const o = Math.min(end, t.end) - Math.max(start, t.start)
    if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) || 0) + o)
  }
  if (overlap.size) return [...overlap].sort((a, b) => b[1] - a[1])[0][0]
  let best = null
  let dist = Infinity
  const mid = (start + end) / 2
  for (const t of turns) {
    const d = mid < t.start ? t.start - mid : mid > t.end ? mid - t.end : 0
    if (d < dist) (dist = d), (best = t.speaker)
  }
  return best
}

// Доля времени [start, end], которую занимает главный спикер, и сам он.
function dominant(turns, start, end) {
  const by = new Map()
  let total = 0
  for (const t of turns) {
    const o = Math.min(end, t.end) - Math.max(start, t.start)
    if (o > 0) by.set(t.speaker, (by.get(t.speaker) || 0) + o), (total += o)
  }
  if (!total) return { speaker: speakerAt(turns, start, end), share: 1 }
  const [speaker, dur] = [...by].sort((a, b) => b[1] - a[1])[0]
  return { speaker, share: dur / total }
}

// Предложение: слова до .?!… или до конца сегмента whisper.
function sentences(words) {
  const out = [[]]
  for (const w of words) {
    out[out.length - 1].push(w)
    if (w.segEnd || /[.?!…]["»)]*\s*$/.test(w.text)) out.push([])
  }
  return out.filter((s) => s.length)
}

// Таймкоды отдельных слов у whisper неточные: граница реплики, посчитанная
// пословно, съезжает на слово в ту или другую сторону («…медленнее. Чтобы |
// мы успели»). Предложение целиком whisper таймирует хорошо, а собеседники
// почти всегда сменяются на границе предложения. Поэтому спикера назначаем
// предложению по большинству и режем пословно, только если внутри длинного
// предложения второй голос занимает заметную долю.
const SPLIT_SHARE = 0.7 // главный голос занимает меньше — режем по словам
const SPLIT_MIN_SEC = 3 // короче — не режем: скорее ошибка таймкодов

// words: [{ start, end, text, segEnd? }] — слова whisper с таймкодами.
// Возвращает реплики: [{ speaker, start, end, text }], соседние слова одного
// спикера склеены.
function toReplicas(words, rawTurns) {
  const turns = flatten(rawTurns)
  const labeled = []
  for (const s of sentences(words)) {
    const start = s[0].start
    const end = s[s.length - 1].end
    const d = dominant(turns, start, end)
    const split = end - start >= SPLIT_MIN_SEC && d.share < SPLIT_SHARE
    for (const w of s)
      labeled.push({ ...w, speaker: (split ? speakerAt(turns, w.start, w.end) : d.speaker) || 1 })
  }
  const out = []
  for (const w of labeled) {
    const speaker = w.speaker
    const last = out[out.length - 1]
    if (last && last.speaker === speaker) {
      last.text += w.text
      last.end = w.end
    } else out.push({ speaker, start: w.start, end: w.end, text: w.text })
  }
  for (const r of out) r.text = r.text.replace(/\s+/g, ' ').trim()
  return out.filter((r) => r.text)
}

// Слова с таймкодами из полного JSON whisper-cli (-ojf). Сегмент whisper
// длиной 8–10 секунд часто захватывает смену голоса, поэтому спикера
// присваиваем каждому слову. Слово = токены до следующего, начинающегося
// с пробела; служебные токены [_BEG_], [_TT_123] пропускаем.
function wordsFromWhisperJson(json) {
  const words = []
  for (const seg of json.transcription || []) {
    for (const tok of seg.tokens || []) {
      const text = tok.text || ''
      if (/^\[_[A-Z]+_?\d*\]$/.test(text.trim()) || !tok.offsets) continue
      const start = tok.offsets.from / 1000
      const end = tok.offsets.to / 1000
      const last = words[words.length - 1]
      if (last && !/^\s/.test(text) && !last.segEnd) {
        last.text += text
        last.end = Math.max(last.end, end)
      } else words.push({ start, end, text: /^\s/.test(text) ? text : ' ' + text })
    }
    // Граница сегмента — всегда граница слова и предложения.
    if (words.length) words[words.length - 1].segEnd = true
  }
  return words
}

// Текст с репликами: «Спикер 1: …» с пустой строкой между репликами.
function replicasText(replicas, label = (n) => `Спикер ${n}`) {
  return replicas.map((r) => `${label(r.speaker)}: ${r.text}`).join('\n\n')
}

// Спикер в SRT: «[Спикер 2] текст» — по тому, кто говорил дольше всего
// в границах субтитра.
function labelSrt(srt, replicas, label) {
  return srt.replace(
    /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\n([^\n])/g,
    (all, h1, m1, s1, ms1, h2, m2, s2, ms2, first) => {
      const a = +h1 * 3600 + +m1 * 60 + +s1 + +ms1 / 1000
      const b = +h2 * 3600 + +m2 * 60 + +s2 + +ms2 / 1000
      let best = null
      let most = 0
      for (const r of replicas) {
        const o = Math.min(b, r.end) - Math.max(a, r.start)
        if (o > most) (most = o), (best = r.speaker)
      }
      return best ? all.slice(0, -1) + `[${label(best)}] ` + first : all
    },
  )
}

module.exports = {
  diarize,
  labelSrt,
  toReplicas,
  speakerAt,
  wordsFromWhisperJson,
  replicasText,
  CLUSTER_THRESHOLD,
}
