export interface Chunk {
  timestamp: [number, number | null]
  text: string
}

export interface TranscriptOutput {
  text: string
  chunks?: Chunk[]
}

function pad(n: number, len = 2): string {
  return String(Math.floor(n)).padStart(len, '0')
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function srtTime(seconds: number): string {
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000)
  return `${formatTime(seconds)},${pad(ms, 3)}`
}

export function toSrt(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => {
      const start = c.timestamp[0] ?? 0
      const end = c.timestamp[1] ?? start + 2
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${c.text.trim()}\n`
    })
    .join('\n')
}

// Разбирает SRT-вывод whisper.cpp в сегменты для показа с таймкодами.
export function parseSrt(srt: string): Chunk[] {
  const blocks = srt.replace(/\r/g, '').trim().split(/\n\n+/)
  const out: Chunk[] = []
  for (const b of blocks) {
    const lines = b.split('\n')
    const timeLine = lines.find((l) => l.includes('-->'))
    if (!timeLine) continue
    const m = timeLine.match(
      /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/,
    )
    if (!m) continue
    const start =
      +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim()
    if (text) out.push({ timestamp: [start, end], text })
  }
  return out
}

export function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
