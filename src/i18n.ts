// Локализация интерфейса. Русский и индонезийский.
export type UiLang = 'ru' | 'id'

export const UI_LANGS: { code: UiLang; label: string }[] = [
  { code: 'ru', label: 'RU' },
  { code: 'id', label: 'ID' },
]

interface Strings {
  subtitle: string
  model: string
  language: string
  autoDetect: string
  fastMode: string
  fastTitle: string
  badge: string
  dropHere: string
  chooseFile: string
  record: string
  stopRecord: string
  courseFolder: string
  formats: string
  preparing: string
  decoding: string
  recognizing: string
  elapsed: string
  recognitionLabel: string
  live: string
  liveHint: string
  beforeError: string
  copy: string
  result: string
  openMd: string
  showFinder: string
  txtSaved: string
  recordingSaved: string
  recordingsFolder: string
  footer: string
  micName: string
  course: string
  micDenied: string
  micNoAccess: string
  decodeError: string
  fileN: (i: number, total: number) => string
  courseSaved: (count: number | undefined) => string
  notRecognized: (n: number) => string
}

export const STRINGS: Record<UiLang, Strings> = {
  ru: {
    subtitle:
      'Аудио → текст нативно на Mac. Модель Whisper large-v3-turbo, ускорение Metal. Всё локально.',
    model: 'Модель',
    language: 'Язык',
    autoDetect: 'Автоопределение',
    fastMode: '🚀 Быстрый режим',
    fastTitle:
      'Жадное декодирование: быстрее ~2× почти без потерь на чистой речи (лекции, вебинары)',
    badge: '⚡ Metal · локально',
    dropHere: 'Перетащи файл сюда или',
    chooseFile: 'Выбрать файл',
    record: '🎤 Записать с микрофона',
    stopRecord: '⏹ Остановить запись',
    courseFolder: '📚 Папка курса → MD',
    formats: 'mp3, wav, m4a, ogg, mp4, mov и другие форматы',
    preparing: 'Подготовка…',
    decoding: 'Декодирование аудио…',
    recognizing: 'Распознавание речи…',
    elapsed: 'прошло',
    recognitionLabel: 'Распознавание',
    live: 'Распознаётся…',
    liveHint: 'текст появляется в реальном времени',
    beforeError: 'Распознано до обрыва',
    copy: '📋 Копировать',
    result: 'Результат',
    openMd: 'Открыть .md',
    showFinder: 'Показать в Finder',
    txtSaved: '✓ TXT сохранён в Загрузки',
    recordingSaved: '🎙️ Запись сохранена в «Документы/Транскрибер»',
    recordingsFolder: '📂 Папка записей',
    footer: 'whisper.cpp · Metal · модель Whisper large-v3-turbo от OpenAI',
    micName: 'Запись с микрофона',
    course: 'Курс',
    micDenied:
      'Нет доступа к микрофону. Открой Системные настройки → Конфиденциальность и безопасность → Микрофон и включи «Транскрибер», затем перезапусти приложение.',
    micNoAccess: 'Нет доступа к микрофону.',
    decodeError: 'Не удалось декодировать файл. ',
    fileN: (i, total) => `Файл ${i} из ${total}`,
    courseSaved: (count) => `✓ Документ курса сохранён · файлов: ${count}`,
    notRecognized: (n) => ` · не распознано: ${n}`,
  },
  id: {
    subtitle:
      'Audio → teks secara native di Mac. Model Whisper large-v3-turbo, akselerasi Metal. Semuanya lokal.',
    model: 'Model',
    language: 'Bahasa',
    autoDetect: 'Deteksi otomatis',
    fastMode: '🚀 Mode cepat',
    fastTitle:
      'Dekode greedy: ~2× lebih cepat hampir tanpa kehilangan kualitas pada ucapan jernih (kuliah, webinar)',
    badge: '⚡ Metal · lokal',
    dropHere: 'Seret berkas ke sini atau',
    chooseFile: 'Pilih berkas',
    record: '🎤 Rekam dari mikrofon',
    stopRecord: '⏹ Hentikan rekaman',
    courseFolder: '📚 Folder kursus → MD',
    formats: 'mp3, wav, m4a, ogg, mp4, mov dan format lainnya',
    preparing: 'Menyiapkan…',
    decoding: 'Mendekode audio…',
    recognizing: 'Mengenali ucapan…',
    elapsed: 'berlalu',
    recognitionLabel: 'Pengenalan',
    live: 'Mengenali…',
    liveHint: 'teks muncul secara real-time',
    beforeError: 'Dikenali sebelum terputus',
    copy: '📋 Salin',
    result: 'Hasil',
    openMd: 'Buka .md',
    showFinder: 'Tampilkan di Finder',
    txtSaved: '✓ TXT disimpan ke folder Unduhan',
    recordingSaved: '🎙️ Rekaman disimpan di «Documents/Транскрибер»',
    recordingsFolder: '📂 Folder rekaman',
    footer: 'whisper.cpp · Metal · model Whisper large-v3-turbo dari OpenAI',
    micName: 'Rekaman mikrofon',
    course: 'Kursus',
    micDenied:
      'Tidak ada akses ke mikrofon. Buka Pengaturan Sistem → Privasi & Keamanan → Mikrofon lalu aktifkan «Транскрибер», kemudian mulai ulang aplikasi.',
    micNoAccess: 'Tidak ada akses ke mikrofon.',
    decodeError: 'Gagal mendekode berkas. ',
    fileN: (i, total) => `Berkas ${i} dari ${total}`,
    courseSaved: (count) => `✓ Dokumen kursus disimpan · berkas: ${count}`,
    notRecognized: (n) => ` · tidak dikenali: ${n}`,
  },
}
