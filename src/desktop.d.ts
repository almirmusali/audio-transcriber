export interface TranscribePayload {
  path?: string
  bytes?: ArrayBuffer
  name?: string
  language: string
}

export interface TranscribeResult {
  text: string
  srt: string
  savedPath: string | null
}

export interface DesktopApi {
  isDesktop: true
  openFile: () => Promise<string | null>
  pathForFile: (file: File) => string | null
  requestMic: () => Promise<true | 'denied'>
  transcribe: (payload: TranscribePayload) => Promise<TranscribeResult>
  saveAs: (defaultName: string, content: string) => Promise<string | null>
  reveal: (filePath: string) => Promise<void>
  onStatus: (cb: (v: string) => void) => () => void
  onPartial: (cb: (v: string) => void) => () => void
  onProgress: (cb: (v: number) => void) => () => void
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}
