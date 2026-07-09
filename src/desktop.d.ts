export interface TranscribePayload {
  path?: string
  bytes?: ArrayBuffer
  name?: string
  language: string
  fast?: boolean
}

export interface TranscribeResult {
  text: string
  srt: string
  savedPath: string | null
  recordingPath?: string | null
}

export interface CourseProgress {
  index: number
  total: number
  name: string
}

export interface CourseResult {
  md: string
  mdPath: string
  fileCount: number
  failed: number
}

export interface DesktopApi {
  isDesktop: true
  openFile: () => Promise<string | null>
  pathForFile: (file: File) => string | null
  requestMic: () => Promise<true | 'denied'>
  transcribe: (payload: TranscribePayload) => Promise<TranscribeResult>
  openFolder: () => Promise<string | null>
  transcribeCourse: (payload: {
    dir: string
    language: string
    fast?: boolean
  }) => Promise<CourseResult>
  openPath: (p: string) => Promise<void>
  aiProcess: (payload: {
    apiKey: string
    model: string
    prompt: string
    text: string
  }) => Promise<string>
  saveAs: (defaultName: string, content: string) => Promise<string | null>
  reveal: (filePath: string) => Promise<void>
  openRecordings: () => Promise<void>
  onStatus: (cb: (v: string) => void) => () => void
  onPartial: (cb: (v: string) => void) => () => void
  onProgress: (cb: (v: number) => void) => () => void
  onCourseProgress: (cb: (v: CourseProgress) => void) => () => void
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}
