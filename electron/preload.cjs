const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  // Нативный диалог выбора файла → возвращает путь.
  openFile: () => ipcRenderer.invoke('open-file'),
  // Путь файла, брошенного в окно (drag-and-drop).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },
  // Запуск распознавания. payload: { path?, bytes?, name?, language }
  // Запрос доступа к микрофону (macOS TCC). Возвращает true | 'denied'.
  requestMic: () => ipcRenderer.invoke('request-mic'),
  transcribe: (payload) => ipcRenderer.invoke('transcribe', payload),
  // Папочный режим: выбор папки курса и распознавание всей папки в один .md
  openFolder: () => ipcRenderer.invoke('open-folder'),
  // 'dir' | 'file' | null — чтобы брошенную папку отправить в папочный режим.
  pathKind: (p) => ipcRenderer.invoke('path-kind', p),
  transcribeCourse: (payload) => ipcRenderer.invoke('transcribe-course', payload),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  // Отмена текущей транскрипции (одиночной или курса).
  cancel: () => ipcRenderer.invoke('cancel-transcribe'),
  // Копирование в системный буфер обмена.
  copy: (text) => ipcRenderer.invoke('copy-text', text),
  // Плавающая плашка записи (always-on-top).
  recShow: () => ipcRenderer.send('rec-show'),
  recHide: () => ipcRenderer.send('rec-hide'),
  recUpdate: (state) => ipcRenderer.send('rec-update', state),
  onOverlayCommand: (cb) => {
    const h = (_e, a) => cb(a)
    ipcRenderer.on('overlay-command', h)
    return () => ipcRenderer.removeListener('overlay-command', h)
  },
  // AI-обработка транскрипта через Claude API.
  aiProcess: (payload) => ipcRenderer.invoke('ai-process', payload),
  // Личный словарь имён и терминов для whisper (общий файл на все проекты).
  dictGet: () => ipcRenderer.invoke('dict-get'),
  dictSet: (text) => ipcRenderer.invoke('dict-set', text),
  dictReveal: () => ipcRenderer.invoke('dict-reveal'),
  // Имя файла по смыслу первых строк расшифровки (Sonnet).
  suggestName: (payload) => ipcRenderer.invoke('suggest-name', payload),
  // Отправка расшифровки в «Банк идей» — только если его адрес настроен.
  ideaEnabled: () => ipcRenderer.invoke('idea-enabled'),
  sendIdea: (text, audioPath) =>
    ipcRenderer.invoke('send-idea', { text, audioPath: audioPath || null }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveAs: (defaultName, content) =>
    ipcRenderer.invoke('save-as', defaultName, content),
  reveal: (filePath) => ipcRenderer.invoke('reveal', filePath),
  openRecordings: () => ipcRenderer.invoke('open-recordings'),
  // Подписки на ход выполнения.
  onStatus: (cb) => {
    const h = (_e, v) => cb(v)
    ipcRenderer.on('status', h)
    return () => ipcRenderer.removeListener('status', h)
  },
  onPartial: (cb) => {
    const h = (_e, v) => cb(v)
    ipcRenderer.on('partial', h)
    return () => ipcRenderer.removeListener('partial', h)
  },
  onProgress: (cb) => {
    const h = (_e, v) => cb(v)
    ipcRenderer.on('progress', h)
    return () => ipcRenderer.removeListener('progress', h)
  },
  onCourseProgress: (cb) => {
    const h = (_e, v) => cb(v)
    ipcRenderer.on('course-progress', h)
    return () => ipcRenderer.removeListener('course-progress', h)
  },
})
