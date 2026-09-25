#!/usr/bin/env bash
# Скачивает модель, ffmpeg и собирает whisper-cli (Metal) — всё, что не хранится в git.
# Требуется Apple Silicon (arm64), cmake, Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p resources/bin resources/models build-tools

echo "==> 1/4 Модель ggml-large-v3-turbo-q5_0 (~547 МБ)"
MODEL=resources/models/ggml-large-v3-turbo-q5_0.bin
if [ ! -f "$MODEL" ]; then
  curl -L -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
fi

echo "==> 2/4 Статический arm64 ffmpeg (~39 МБ)"
if [ ! -f resources/bin/ffmpeg ]; then
  curl -L -o resources/bin/ffmpeg \
    "https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/darwin-arm64"
  chmod +x resources/bin/ffmpeg
  codesign --force -s - resources/bin/ffmpeg || true
fi

echo "==> 3/4 Сборка whisper-cli (Metal)"
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

echo "==> 4/4 Распознавание говорящих: sherpa-onnx + модели (~60 МБ)"
# Готовый бинарник sherpa-onnx ищет libonnxruntime.dylib через @loader_path —
# кладём библиотеку рядом с ним, и он работает на любом Mac.
SHERPA_VER=1.13.8
DIAR=resources/models/diarization
mkdir -p "$DIAR"
if [ ! -f resources/bin/sherpa-onnx-offline-speaker-diarization ] || [ ! -f resources/bin/libonnxruntime.dylib ]; then
  TMP=$(mktemp -d)
  NAME="sherpa-onnx-v${SHERPA_VER}-osx-arm64-shared-no-tts"
  curl -L -o "$TMP/sherpa.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VER}/${NAME}.tar.bz2"
  tar -xjf "$TMP/sherpa.tar.bz2" -C "$TMP"
  cp "$TMP/$NAME/bin/sherpa-onnx-offline-speaker-diarization" resources/bin/
  cp "$TMP/$NAME/lib/libonnxruntime.dylib" resources/bin/
  codesign --force -s - resources/bin/sherpa-onnx-offline-speaker-diarization resources/bin/libonnxruntime.dylib || true
  rm -rf "$TMP"
fi
if [ ! -f "$DIAR/segmentation.onnx" ]; then
  TMP=$(mktemp -d)
  curl -L -o "$TMP/seg.tar.bz2" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
  tar -xjf "$TMP/seg.tar.bz2" -C "$TMP"
  cp "$TMP/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" "$DIAR/segmentation.onnx"
  rm -rf "$TMP"
fi
if [ ! -f "$DIAR/embedding.onnx" ]; then
  curl -L -o "$DIAR/embedding.onnx" \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"
fi

echo "✓ Готово. Теперь: npm install && npm run app"
