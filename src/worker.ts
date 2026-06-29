/// <reference lib="webworker" />
import {
  pipeline,
  env,
  WhisperTextStreamer,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from '@huggingface/transformers'

// Модель turbo лежит локально в /public/models — грузим её с диска,
// не качая 0.5+ ГБ из интернета в память браузера (из-за чего падал Safari).
// base при этом по-прежнему может догрузиться из сети, если выбран.
env.allowLocalModels = true
env.allowRemoteModels = true
env.localModelPath = '/models/'

// Модели на выбор. turbo — лучшее качество/скорость на WebGPU,
// base — лёгкий универсальный фолбэк (работает и на WASM/CPU).
const MODELS = {
  turbo: 'onnx-community/whisper-large-v3-turbo',
  base: 'onnx-community/whisper-base',
} as const

type ModelKey = keyof typeof MODELS

// Кешируем загруженный пайплайн, чтобы не качать модель повторно.
let cachedKey: string | null = null
let cachedPipe: AutomaticSpeechRecognitionPipeline | null = null

async function getPipeline(model: ModelKey, device: 'webgpu' | 'wasm') {
  const key = `${model}:${device}`
  if (cachedKey === key && cachedPipe) return cachedPipe

  const dtype =
    device === 'webgpu'
      ? { encoder_model: 'q4f16' as const, decoder_model_merged: 'q4f16' as const }
      : { encoder_model: 'q8' as const, decoder_model_merged: 'q8' as const }

  const options: any = {
    device,
    dtype,
    progress_callback: (p: ProgressInfo) => {
      self.postMessage({ type: 'progress', payload: p })
    },
  }
  cachedPipe = (await (pipeline as any)(
    'automatic-speech-recognition',
    MODELS[model],
    options,
  )) as AutomaticSpeechRecognitionPipeline
  cachedKey = key
  return cachedPipe
}

self.addEventListener('message', async (e: MessageEvent) => {
  const { type } = e.data
  if (type !== 'transcribe') return

  const {
    audio,
    model,
    device,
    language,
  }: {
    audio: Float32Array
    model: ModelKey
    device: 'webgpu' | 'wasm'
    language: string | null
  } = e.data

  try {
    self.postMessage({ type: 'status', payload: 'Загрузка модели…' })
    const transcriber = await getPipeline(model, device)

    self.postMessage({ type: 'status', payload: 'Распознавание речи…' })

    // Потоковый вывод: текст уходит в UI по мере генерации, поэтому даже
    // если процесс прервётся, уже распознанная часть не пропадёт.
    const chunks: { text: string; timestamp: [number, number | null] }[] = []

    let timePrecision = 0.02
    try {
      const fe = (transcriber as any).processor?.feature_extractor?.config
      const mc = (transcriber as any).model?.config
      if (fe?.chunk_length && mc?.max_source_positions) {
        timePrecision = fe.chunk_length / mc.max_source_positions
      }
    } catch {
      /* оставляем дефолт */
    }

    const emit = () =>
      self.postMessage({
        type: 'partial',
        payload: chunks.map((c) => c.text).join(''),
      })

    const streamer = new WhisperTextStreamer((transcriber as any).tokenizer, {
      time_precision: timePrecision,
      on_chunk_start: (start: number) => {
        chunks.push({ text: '', timestamp: [start, null] })
      },
      callback_function: (text: string) => {
        if (chunks.length === 0) chunks.push({ text: '', timestamp: [0, null] })
        chunks[chunks.length - 1].text += text
        emit()
      },
      on_chunk_end: (end: number) => {
        if (chunks.length) chunks[chunks.length - 1].timestamp[1] = end
      },
    })

    const output = await transcriber(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: language ?? undefined,
      task: 'transcribe',
      streamer,
    })

    self.postMessage({ type: 'result', payload: output })
  } catch (err) {
    self.postMessage({
      type: 'error',
      payload: err instanceof Error ? err.message : String(err),
    })
  }
})
