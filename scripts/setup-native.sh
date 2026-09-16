#!/usr/bin/env bash
# Скачивает модель, ffmpeg и собирает whisper-cli (Metal) — всё, что не хранится в git.
# Требуется Apple Silicon (arm64), cmake, Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p resources/bin resources/models build-tools

echo "==> 1/3 Модель ggml-large-v3-turbo-q5_0 (~547 МБ)"
MODEL=resources/models/ggml-large-v3-turbo-q5_0.bin
if [ ! -f "$MODEL" ]; then
  curl -L -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
fi

echo "==> 2/3 Статический arm64 ffmpeg (~39 МБ)"
if [ ! -f resources/bin/ffmpeg ]; then
  curl -L -o resources/bin/ffmpeg \
    "https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/darwin-arm64"
  chmod +x resources/bin/ffmpeg
  codesign --force -s - resources/bin/ffmpeg || true
fi

echo "==> 3/3 Сборка whisper-cli (Metal)"
# Собираем статически: иначе whisper-cli ищет libwhisper.dylib по абсолютному пути
# папки сборки и на чужом Mac падает с «Library not loaded».
if [ -f resources/bin/whisper-cli ] && otool -L resources/bin/whisper-cli | grep -q '@rpath'; then
  echo "    старый whisper-cli привязан к папке сборки — пересобираю"
  rm resources/bin/whisper-cli
fi
if [ ! -f resources/bin/whisper-cli ]; then
  if [ ! -d build-tools/whisper.cpp ]; then
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp build-tools/whisper.cpp
  fi
  cmake -S build-tools/whisper.cpp -B build-tools/whisper.cpp/build-static \
    -DGGML_NATIVE=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
  cmake --build build-tools/whisper.cpp/build-static --config Release -j --target whisper-cli
  cp build-tools/whisper.cpp/build-static/bin/whisper-cli resources/bin/whisper-cli
  codesign --force -s - resources/bin/whisper-cli || true
fi

echo "✓ Готово. Теперь: npm install && npm run app"
