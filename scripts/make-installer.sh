#!/usr/bin/env bash
# Собирает установщик (.dmg) для Apple Silicon одной командой:
# нативные ресурсы -> renderer -> .app -> .dmg в release/.
# Требуется: macOS arm64, Node.js, cmake, Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname -m)" = "arm64" ] || { echo "Нужен Mac на Apple Silicon"; exit 1; }
# cmake нужен только для сборки whisper-cli — если бинарник уже лежит, обойдёмся без него.
if [ ! -f resources/bin/whisper-cli ]; then
  command -v cmake >/dev/null || { echo "Нет cmake: brew install cmake"; exit 1; }
fi

echo "==> Зависимости npm"
[ -d node_modules ] || npm install

echo "==> Модель, ffmpeg, whisper-cli"
bash scripts/setup-native.sh

echo "==> Сборка приложения и .dmg"
npm run build
npx electron-builder --mac dmg

DMG=$(ls -t release/*.dmg | head -1)
echo
echo "✓ Установщик: $DMG ($(du -h "$DMG" | cut -f1))"
echo
echo "Приложение не подписано Apple ID. Если DMG попал на второй Mac"
echo "через браузер или AirDrop, после переноса в «Программы» выполнить:"
echo '  xattr -cr "/Applications/Транскрибер.app"'
