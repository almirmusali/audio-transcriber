# 🎙️ Транскрибер

Нативное приложение для macOS (Apple Silicon): аудио/видео → текст. Полностью локально,
без интернета и без оплаты за минуты. Движок — **Whisper large-v3-turbo** на
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) с ускорением **Metal**.

## Возможности

- Распознавание речи на ~100 языках (русский, English, **Bahasa Indonesia**, и др.)
- Живой вывод текста по мере распознавания + тайм-коды
- Экспорт в **TXT** и **SRT** (субтитры), авто-сохранение TXT в «Загрузки»
- Выбор файла, drag-and-drop или запись с микрофона
- Всё работает офлайн; аудио никуда не уходит

## Установка готового приложения

Скачай `Транскрибер-1.0.0.dmg`, открой, перетащи «Транскрибер» в «Программы».

> Приложение не подписано Apple ID. При первом запуске macOS может предупредить.
> Тогда: **правый клик по иконке → «Открыть» → «Открыть»**, либо в терминале:
> ```sh
> xattr -cr "/Applications/Транскрибер.app"
> ```

## Сборка из исходников

Требуется: macOS на Apple Silicon, Node.js, cmake, Xcode Command Line Tools.

```sh
npm install
npm run setup    # качает модель + ffmpeg, собирает whisper-cli (Metal)
npm run app      # запуск в режиме разработки
npm run app:build  # собрать .app и .dmg в release/
```

## Архитектура

- **Renderer** — React + Vite + TypeScript (`src/`). Тот же UI в браузере и в приложении.
- **Main** (`electron/main.cjs`) — ffmpeg конвертит вход в WAV 16кГц, `whisper-cli`
  распознаёт, стримит сегменты в UI, пишет TXT/SRT.
- **Бинарники и модель** (`resources/bin`, `resources/models`) не хранятся в git —
  их ставит `npm run setup`.

Лицензия: MIT.
