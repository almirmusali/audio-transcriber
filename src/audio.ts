// Декодирует любой аудио/видео-файл в моно Float32Array @ 16 кГц —
// именно такой формат ждёт Whisper.
const TARGET_SAMPLE_RATE = 16000

export async function decodeToPcm(file: Blob): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer()
  // AudioContext с заданной частотой сам выполняет ресемплинг.
  const AudioCtx: typeof AudioContext =
    window.AudioContext || (window as any).webkitAudioContext
  const ctx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE })
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    return toMono(decoded)
  } finally {
    await ctx.close()
  }
}

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0)
  }
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const mono = new Float32Array(left.length)
  for (let i = 0; i < left.length; i++) {
    mono[i] = (left[i] + right[i]) / 2
  }
  return mono
}
