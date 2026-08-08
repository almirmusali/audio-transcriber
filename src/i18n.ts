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
  stop: string
  pause: string
  resume: string
  stats: (seconds: number, chars: number) => string
  ai: {
    title: string
    keyPlaceholder: string
    keyHint: string
    model: string
    promptPlaceholder: string
    run: string
    running: string
    resultTitle: string
    presets: { label: string; prompt: string }[]
  }
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
    stop: '⏹ Остановить',
    pause: '⏸ Пауза',
    resume: '▶️ Продолжить',
    stats: (s, c) =>
      `⏱ ${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин · ${c.toLocaleString('ru-RU')} знаков`,
    ai: {
      title: '🤖 Обработка через ИИ (по промпту)',
      keyPlaceholder: 'Anthropic API-ключ (sk-ant-…)',
      keyHint:
        'Ключ хранится только на этом компьютере. Обработка идёт через Claude API — это платно, по вашему ключу (в отличие от бесплатной локальной транскрипции).',
      model: 'Модель',
      promptPlaceholder: 'Свой запрос к тексту…',
      run: '✨ Обработать',
      running: 'Обрабатываю…',
      resultTitle: 'Результат ИИ',
      presets: [
        {
          label: 'Саммари',
          prompt:
            'Сделай краткое, но ёмкое саммари этого транскрипта: главные мысли и выводы маркированным списком. Отвечай на русском, в Markdown.',
        },
        {
          label: 'Тезисы',
          prompt:
            'Выдели ключевые тезисы и важные цитаты из транскрипта. Отвечай на русском, в Markdown.',
        },
        {
          label: 'Конспект',
          prompt:
            'Преобразуй транскрипт в структурированный конспект с заголовками и подпунктами (Markdown). Отвечай на русском.',
        },
        {
          label: 'Причесать',
          prompt:
            'Отредактируй транскрипт: убери слова-паразиты и повторы, расставь пунктуацию и абзацы, сохрани смысл и стиль речи. Верни готовый текст.',
        },
      ],
    },
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
    stop: '⏹ Hentikan',
    pause: '⏸ Jeda',
    resume: '▶️ Lanjutkan',
    stats: (s, c) =>
      `⏱ ${Math.floor(s / 3600)} j ${Math.round((s % 3600) / 60)} mnt · ${c.toLocaleString('id-ID')} karakter`,
    ai: {
      title: '🤖 Pemrosesan dengan AI (via perintah)',
      keyPlaceholder: 'Kunci API Anthropic (sk-ant-…)',
      keyHint:
        'Kunci disimpan hanya di komputer ini. Pemrosesan lewat Claude API — berbayar, memakai kunci Anda (berbeda dari transkripsi lokal yang gratis).',
      model: 'Model',
      promptPlaceholder: 'Perintah Anda untuk teks…',
      run: '✨ Proses',
      running: 'Memproses…',
      resultTitle: 'Hasil AI',
      presets: [
        {
          label: 'Ringkasan',
          prompt:
            'Buat ringkasan singkat namun padat dari transkrip ini: gagasan dan kesimpulan utama dalam daftar berpoin. Jawab dalam Bahasa Indonesia, format Markdown.',
        },
        {
          label: 'Poin utama',
          prompt:
            'Ekstrak poin-poin kunci dan kutipan penting dari transkrip. Jawab dalam Bahasa Indonesia, format Markdown.',
        },
        {
          label: 'Catatan',
          prompt:
            'Ubah transkrip menjadi catatan terstruktur dengan judul dan sub-poin (Markdown). Jawab dalam Bahasa Indonesia.',
        },
        {
          label: 'Rapikan',
          prompt:
            'Edit transkrip: hapus kata pengisi dan pengulangan, tambahkan tanda baca dan paragraf, pertahankan makna dan gaya. Kembalikan teks yang sudah rapi.',
        },
      ],
    },
  },
}
