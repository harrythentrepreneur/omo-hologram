#!/usr/bin/env bash
#
# Installs the system-side prerequisites for the local voice pipeline.
# Two pipeline variants are supported, both selectable at runtime via
# the *_BACKEND env vars on the omo server:
#
#   1) whisper_cpp + edge_tts + gemini_flash  (low-effort cloud-LLM path)
#      - whisper-cpp     (Whisper STT)
#      - edge-tts        (free Microsoft neural TTS)
#      - GEMINI_API_KEY  (cheap Gemini 2.5 Flash text mode)
#
#   2) mlx_omni  (fully local — Whisper-MLX + Qwen3-8B-4bit + F5-TTS-MLX)
#      - mlx-omni-server (OpenAI-compatible local server, port 10240)
#      - HuggingFace weights for the three MLX models above
#
# Re-runnable. Skips work that's already done. Pass `--mlx` to also do
# the heavy mlx_omni install (~17 GB of weights).

set -euo pipefail

WANT_MLX=0
for arg in "$@"; do
  case "$arg" in
    --mlx) WANT_MLX=1 ;;
  esac
done

cyan() { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required (https://brew.sh). Aborting." >&2
  exit 1
fi

cyan "─── whisper.cpp ───"
if ! command -v whisper-cli >/dev/null 2>&1; then
  brew install whisper-cpp
else
  green "whisper-cli already installed at $(command -v whisper-cli)"
fi

WHISPER_MODELS_DIR="${WHISPER_MODELS_DIR:-$HOME/.cache/whisper}"
WHISPER_MODEL="${WHISPER_MODEL:-large-v3-turbo}"
mkdir -p "$WHISPER_MODELS_DIR"

MODEL_FILE="$WHISPER_MODELS_DIR/ggml-${WHISPER_MODEL}.bin"
if [ ! -f "$MODEL_FILE" ]; then
  cyan "─── downloading ggml-${WHISPER_MODEL} ───"
  url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"
  curl -L --fail --progress-bar -o "$MODEL_FILE.partial" "$url"
  mv "$MODEL_FILE.partial" "$MODEL_FILE"
  green "saved $MODEL_FILE"
else
  green "whisper model already present: $MODEL_FILE"
fi

cyan "─── edge-tts ───"
if ! command -v edge-tts >/dev/null 2>&1; then
  if ! command -v pipx >/dev/null 2>&1; then
    brew install pipx
    pipx ensurepath
  fi
  pipx install edge-tts
else
  green "edge-tts already installed at $(command -v edge-tts)"
fi

if [ "$WANT_MLX" -eq 1 ]; then
  cyan "─── mlx-omni-server ───"
  if ! command -v mlx-omni-server >/dev/null 2>&1; then
    if ! command -v pipx >/dev/null 2>&1; then brew install pipx; pipx ensurepath; fi
    pipx install mlx-omni-server
  else
    green "mlx-omni-server already installed at $(command -v mlx-omni-server)"
  fi

  if ! command -v hf >/dev/null 2>&1 && ! command -v huggingface-cli >/dev/null 2>&1; then
    yellow "huggingface CLI not found — install with: pip install huggingface_hub"
    exit 1
  fi
  HFCLI="$(command -v hf || command -v huggingface-cli)"

  cyan "─── pulling MLX models (~9 GB total) ───"
  for repo in \
    mlx-community/Qwen3-8B-4bit \
    mlx-community/whisper-large-v3-turbo \
    lucasnewman/f5-tts-mlx
  do
    echo "    $repo"
    HF_HUB_DISABLE_XET=1 "$HFCLI" download "$repo" --max-workers 1 >/dev/null
  done
  green "MLX weights ready"
fi

cat <<EOF

$(green "Voice deps ready.")

Default (cloud LLM, free TTS, local Whisper):
  add to .env:
    WHISPER_MODEL_PATH=$MODEL_FILE
    TTS_VOICE=zh-CN-XiaoxiaoNeural
  then: http://localhost:8080/?engine=local

Fully local (Qwen3-8B-4bit MLX + Whisper-MLX + F5-TTS-MLX):
  prerequisites: ./bin/install-voice-deps.sh --mlx
  in one terminal: mlx-omni-server --port 10240
  add to .env:
    LLM_BACKEND=mlx_omni
    STT_BACKEND=mlx_omni
    TTS_BACKEND=mlx_omni
  then: http://localhost:8080/?engine=local
EOF
