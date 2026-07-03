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
  transcribeCourse: (payload) => ipcRenderer.invoke('transcribe-course', payload),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
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
