#!/usr/bin/env bash
# Check (and optionally install) the binaries the video skills depend on.
#
#   ./preflight.sh              report status only, change nothing
#   ./preflight.sh --install    install what's missing
#   ./preflight.sh --install --with-whisper   also install a local ASR backend
#
# Deliberately reports before it acts: an unexpected `brew install ffmpeg` on
# someone's machine is a worse outcome than a clear error message.

set -uo pipefail

INSTALL=0
WITH_WHISPER=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --with-whisper) WITH_WHISPER=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

PY="${VT_PYTHON:-python3}"
missing=()
ok=()

have() { command -v "$1" >/dev/null 2>&1; }
pymod() { "$PY" -c "import $1" >/dev/null 2>&1; }

# --- yt-dlp: metadata, captions, heatmap, comments -------------------------
if have yt-dlp || pymod yt_dlp; then
  ver="$( (yt-dlp --version 2>/dev/null) || "$PY" -c 'import yt_dlp;print(yt_dlp.version.__version__)' 2>/dev/null )"
  ok+=("yt-dlp ${ver:-?}")
else
  missing+=("yt-dlp")
fi

# --- ffmpeg: audio energy, clip rendering ----------------------------------
if have ffmpeg; then
  ok+=("ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')")
else
  missing+=("ffmpeg")
fi

# --- whisper: only needed when a video has no captions at all --------------
whisper_backend=""
if pymod mlx_whisper; then whisper_backend="mlx-whisper"
elif pymod faster_whisper; then whisper_backend="faster-whisper"
fi
[[ -n "$whisper_backend" ]] && ok+=("$whisper_backend")

echo "present:"
for x in "${ok[@]:-}"; do [[ -n "$x" ]] && echo "  ✓ $x"; done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "missing:"
  for x in "${missing[@]}"; do echo "  ✗ $x"; done
fi
if [[ -z "$whisper_backend" ]]; then
  echo "  · no local ASR backend (only needed for videos with no captions)"
fi

if [[ $INSTALL -eq 0 ]]; then
  [[ ${#missing[@]} -gt 0 ]] && echo && echo "re-run with --install to fix"
  exit 0
fi

echo
for pkg in "${missing[@]:-}"; do
  case "$pkg" in
    yt-dlp)
      echo "installing yt-dlp via pip…"
      "$PY" -m pip install --quiet --upgrade yt-dlp || echo "  failed" >&2
      ;;
    ffmpeg)
      echo "installing ffmpeg…"
      if have brew; then
        brew install ffmpeg
      elif have conda; then
        conda install -y -c conda-forge ffmpeg
      elif have apt-get; then
        sudo apt-get update && sudo apt-get install -y ffmpeg
      else
        cat >&2 <<'EOF'
  No package manager found (brew / conda / apt-get).
  Install ffmpeg manually, e.g. macOS: https://evermeet.cx/ffmpeg/
  then put ffmpeg and ffprobe on PATH.
EOF
      fi
      ;;
  esac
done

if [[ $WITH_WHISPER -eq 1 && -z "$whisper_backend" ]]; then
  echo "installing a local ASR backend…"
  if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
    "$PY" -m pip install --quiet --upgrade mlx-whisper
  else
    "$PY" -m pip install --quiet --upgrade faster-whisper
  fi
fi

echo
echo "re-checking:"
exec "$0"
