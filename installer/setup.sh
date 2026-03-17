#!/usr/bin/env bash
set -euo pipefail

# ── Colors / helpers ──────────────────────────────────────────────────────────
XGH_LLM_MODEL="${XGH_LLM_MODEL:-}"
XGH_EMBED_MODEL="${XGH_EMBED_MODEL:-}"
XGH_MODEL_PORT="${XGH_MODEL_PORT:-11434}"
_ORIGINAL_XGH_BACKEND="${XGH_BACKEND:-}"   # capture before auto-detection
XGH_BACKEND="${XGH_BACKEND:-}"
XGH_REMOTE_URL="${XGH_REMOTE_URL:-}"

# Determine inference backend: remote if explicitly set, vllm-mlx on Apple Silicon, Ollama everywhere else
if [ -n "$XGH_BACKEND" ] && [ "$XGH_BACKEND" = "remote" ]; then
  : # keep as remote — user explicitly set this
elif [[ "$(uname)" == "Darwin" ]] && [[ "$(uname -m)" == "arm64" ]]; then
  XGH_BACKEND="${XGH_BACKEND:-vllm-mlx}"
else
  XGH_BACKEND="${XGH_BACKEND:-ollama}"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "  ${GREEN}▸${NC} $*"; }
warn()  { echo -e "  ${YELLOW}▸${NC} $*"; }
error() { echo -e "  ${RED}▸${NC} $*" >&2; }
lane()  { echo ""; echo -e "  ${CYAN}━━━${NC} ${BOLD}$*${NC}"; echo ""; }

echo ""
echo -e "  ${BOLD}lossless-claude${NC} ${DIM}memory stack setup${NC}"
echo ""

# ── Dry run guard ─────────────────────────────────────────────────────────────
XGH_DRY_RUN="${XGH_DRY_RUN:-0}"
if [ "$XGH_DRY_RUN" -eq 1 ]; then
  echo "lossless-claude setup.sh: DRY_RUN=1, skipping all installs"
  exit 0
fi

# ── 0. Backend picker ─────────────────────────────────────────────────────────
# Skip picker if XGH_BACKEND was explicitly set by the caller (check original value, before auto-detection)
if [ "$XGH_DRY_RUN" -eq 0 ] && [ -z "${_ORIGINAL_XGH_BACKEND}" ]; then
  if [ -z "${_XGH_BACKEND_PICKED:-}" ]; then
    echo ""
    echo -e "  ${BOLD}Which inference backend?${NC}"
    echo ""
    if [ "$XGH_BACKEND" = "vllm-mlx" ]; then
      echo -e "    ${GREEN}1)${NC} Local — vllm-mlx (macOS Apple Silicon)     ${DIM}[auto-detected]${NC}"
    else
      echo "    1) Local — vllm-mlx (macOS Apple Silicon)"
    fi
    if [ "$XGH_BACKEND" = "ollama" ]; then
      echo -e "    ${GREEN}2)${NC} Local — Ollama (Linux / Intel Mac)          ${DIM}[auto-detected]${NC}"
    else
      echo "    2) Local — Ollama (Linux / Intel Mac)"
    fi
    echo "    3) Remote — connect to another machine's server"
    echo ""
    if [ "$XGH_BACKEND" = "vllm-mlx" ]; then
      _DEFAULT_BACKEND_NUM=1
    else
      _DEFAULT_BACKEND_NUM=2
    fi
    if [ -t 0 ]; then
      read -r -p "  Pick [${_DEFAULT_BACKEND_NUM}]: " _backend_choice
    fi
    _backend_choice="${_backend_choice:-${_DEFAULT_BACKEND_NUM}}"
    case "$_backend_choice" in
      1) XGH_BACKEND="vllm-mlx" ;;
      2) XGH_BACKEND="ollama" ;;
      3) XGH_BACKEND="remote" ;;
      *) : ;; # keep auto-detected
    esac
    _XGH_BACKEND_PICKED=1
  fi
fi

# ── Remote URL prompt and validation ─────────────────────────────────────────
if [ "$XGH_BACKEND" = "remote" ] && [ "$XGH_DRY_RUN" -eq 0 ]; then
  if [ -z "$XGH_REMOTE_URL" ]; then
    echo ""
    if [ -t 0 ]; then
      read -r -p "  Remote server URL [http://192.168.1.x:11434]: " XGH_REMOTE_URL
    fi
    XGH_REMOTE_URL="${XGH_REMOTE_URL:-}"
    if [ -z "$XGH_REMOTE_URL" ]; then
      error "XGH_REMOTE_URL is required for the remote backend — set it via environment variable or rerun interactively"
      exit 1
    fi
  fi
  if [[ ! "$XGH_REMOTE_URL" =~ ^https?:// ]]; then
    error "XGH_REMOTE_URL must start with http:// or https://"
    exit 1
  fi
  if curl -sf --max-time 5 "${XGH_REMOTE_URL}/v1/models" >/dev/null 2>&1; then
    info "Remote server reachable ✓"
  else
    warn "Cannot reach ${XGH_REMOTE_URL} — continuing anyway (server may not be running yet)"
  fi
fi

# ── 1. Backend-specific dependencies ──────────────────────────────────────────

# Ensure Homebrew is available on macOS; no-op on other platforms.
# Installs brew interactively if missing and stdin is a TTY; aborts otherwise.
_ensure_brew() {
  if [[ "$(uname)" != "Darwin" ]]; then return; fi
  if command -v brew &>/dev/null; then return; fi
  if [ -t 0 ]; then
    info "Homebrew not found — installing (official installer)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    error "Homebrew is required but not installed, and no interactive terminal is available — install it first: https://brew.sh"
    exit 1
  fi
}

if [ "$XGH_DRY_RUN" -eq 0 ]; then
  lane "Installing backend dependencies"

  # ── Backend-specific dependencies ───────────────────────
  if [ "$XGH_BACKEND" = "vllm-mlx" ]; then
    # ── Apple Silicon: vllm-mlx + Qdrant via Homebrew ────
    _ensure_brew

    # Install uv (Python package installer) if not present
    if ! command -v uv &>/dev/null; then
      info "uv (Python installer)"
      brew install uv
    fi

    # Install vllm-mlx (local model server for Apple Silicon)
    if ! command -v vllm-mlx &>/dev/null; then
      info "vllm-mlx (local model server for Apple Silicon)"
      uv tool install "git+https://github.com/waybarrios/vllm-mlx.git"
    fi

    # Kill any Ollama process squatting on port 11434
    if pgrep -x ollama >/dev/null 2>&1 || pgrep -x "Ollama" >/dev/null 2>&1; then
      warn "Ollama is running and will conflict with vllm-mlx on port 11434 — stopping it"
      osascript -e 'quit app "Ollama"' 2>/dev/null || true
      pkill -f "[Oo]llama" 2>/dev/null || true
      sleep 1
    fi

    # Only install Qdrant for presets that need it
    if ! command -v qdrant &>/dev/null && ! [ -x "${HOME}/.qdrant/bin/qdrant" ]; then
      info "Installing Qdrant..."
      brew install qdrant 2>/dev/null || warn "Could not install Qdrant via brew — install manually or ensure ~/.qdrant/bin/qdrant exists"
    fi

    # Fix Qdrant LaunchAgent plist: add MALLOC_CONF and correct WorkingDirectory
    _QDRANT_BIN=$(command -v qdrant 2>/dev/null || echo "${HOME}/.qdrant/bin/qdrant")
    _QDRANT_PLIST="${HOME}/Library/LaunchAgents/com.qdrant.server.plist"
    _QDRANT_STORAGE="${HOME}/.qdrant/storage"
    mkdir -p "${_QDRANT_STORAGE}"
    if [ -f "$_QDRANT_PLIST" ]; then
      # Inject MALLOC_CONF if not already present
      if ! grep -q "MALLOC_CONF" "$_QDRANT_PLIST" 2>/dev/null; then
        if command -v python3 &>/dev/null; then
          python3 - "$_QDRANT_PLIST" <<'PYEOF'
import sys, re
path = sys.argv[1]
content = open(path).read()
if '<key>MALLOC_CONF</key>' not in content:
    inject = '''    <key>EnvironmentVariables</key>
    <dict>
        <key>MALLOC_CONF</key>
        <string>background_thread:false</string>
    </dict>
'''
    content = content.replace('</dict>\n</plist>', inject + '</dict>\n</plist>')
    open(path, 'w').write(content)
    print('Patched MALLOC_CONF into', path)
PYEOF
          info "Qdrant plist: injected MALLOC_CONF=background_thread:false"
        else
          warn "python3 not found — skipping Qdrant plist MALLOC_CONF patch (memory performance may be affected)"
        fi
      fi
    fi

    # Clear stale WAL locks before starting (harmless if clean)
    find "${_QDRANT_STORAGE}" -path "*/wal/open-*" -delete 2>/dev/null || true

    # Start Qdrant as a background service if not already running
    if ! curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
      info "Starting Qdrant background service..."
      if [ -f "$_QDRANT_PLIST" ]; then
        launchctl unload "$_QDRANT_PLIST" 2>/dev/null || true
        launchctl load "$_QDRANT_PLIST" 2>/dev/null \
          || warn "Could not load Qdrant plist — start manually: launchctl load ${_QDRANT_PLIST}"
      else
        brew services start qdrant 2>/dev/null || warn "Could not start Qdrant service — start manually: brew services start qdrant"
      fi
    else
      info "Qdrant is already running"
    fi

  elif [ "$XGH_BACKEND" = "ollama" ]; then
    if [[ "$(uname)" == "Darwin" ]]; then
      # ── macOS: Ollama + Qdrant via Homebrew ────────
      _ensure_brew
      if ! command -v ollama &>/dev/null; then
        info "Installing Ollama via Homebrew..."
        brew install ollama 2>/dev/null || warn "Could not install Ollama via brew — install manually: brew install ollama"
      fi

      if ! command -v ollama &>/dev/null; then
        warn "Ollama not found after install attempt — install manually: brew install ollama"
        exit 1
      fi
      info "Ollama: $(command -v ollama)"

      if ! command -v qdrant &>/dev/null && ! [ -x "${HOME}/.qdrant/bin/qdrant" ]; then
        info "Installing Qdrant via Homebrew..."
        brew install qdrant 2>/dev/null || warn "Could not install Qdrant via brew — install manually: brew install qdrant"
      fi

      if ! command -v qdrant &>/dev/null && ! [ -x "${HOME}/.qdrant/bin/qdrant" ]; then
        warn "Qdrant not found after install attempt — install manually via Homebrew (brew install qdrant) or place the binary at ${HOME}/.qdrant/bin/qdrant"
        exit 1
      fi
      info "Qdrant: $(command -v qdrant 2>/dev/null || echo "${HOME}/.qdrant/bin/qdrant")"

      # Start services via brew
      if ! curl -sf http://localhost:11434 >/dev/null 2>&1; then
        brew services start ollama 2>/dev/null || warn "Could not start Ollama service — start manually: brew services start ollama"
      fi
      if ! curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
        brew services start qdrant 2>/dev/null || warn "Could not start Qdrant service — start manually: brew services start qdrant"
      else
        info "Qdrant is already running"
      fi

    else
      # ── Linux: Ollama + Qdrant binary ────────────────────

      # Install Ollama if not present
      if ! command -v ollama &>/dev/null; then
        info "Installing Ollama..."
        curl -fsSL https://ollama.com/install.sh | sh
      fi

      # Guard: if ollama still not in PATH, abort
      if ! command -v ollama &>/dev/null; then
        warn "Ollama not found after install attempt — install manually: curl -fsSL https://ollama.com/install.sh | sh"
        exit 1
      fi
      info "Ollama: $(command -v ollama)"

      # Install Qdrant binary (Linux-only tarball)
      if ! [ -x "${HOME}/.qdrant/bin/qdrant" ]; then
        info "Installing Qdrant binary..."
        mkdir -p "${HOME}/.qdrant/bin"
        ARCH=$(uname -m)
        QDRANT_VER=$(curl -sf "https://api.github.com/repos/qdrant/qdrant/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
        curl -fsSL "https://github.com/qdrant/qdrant/releases/download/${QDRANT_VER}/qdrant-${ARCH}-unknown-linux-gnu.tar.gz" \
          | tar -xz -C "${HOME}/.qdrant/bin/"
        chmod +x "${HOME}/.qdrant/bin/qdrant"
        info "Qdrant ${QDRANT_VER} → ${HOME}/.qdrant/bin/qdrant"
      else
        info "Qdrant already installed: ${HOME}/.qdrant/bin/qdrant"
      fi

      # Write systemd user service for Qdrant
      QDRANT_SVC_DIR="${HOME}/.config/systemd/user"
      mkdir -p "$QDRANT_SVC_DIR"
      mkdir -p "${HOME}/.lossless-claude/logs" "${HOME}/.qdrant/storage"
      cat > "${QDRANT_SVC_DIR}/lossless-claude-qdrant.service" <<QDRANTSVCEOF
[Unit]
Description=Qdrant vector database (lossless-claude)
After=network.target

[Service]
ExecStart=%h/.qdrant/bin/qdrant
WorkingDirectory=%h/.qdrant/storage
Restart=always
RestartSec=5
Environment=HOME=%h
Environment=MALLOC_CONF=background_thread:false
StandardOutput=append:%h/.lossless-claude/logs/qdrant.log
StandardError=append:%h/.lossless-claude/logs/qdrant.log

[Install]
WantedBy=default.target
QDRANTSVCEOF
      loginctl enable-linger "$USER" 2>/dev/null || true
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user enable --now lossless-claude-qdrant.service 2>/dev/null \
        || warn "Could not enable lossless-claude-qdrant.service — start manually: systemctl --user start lossless-claude-qdrant"
    fi

  elif [ "$XGH_BACKEND" = "remote" ]; then
    # ── Remote: no local model server — install Qdrant locally for vector storage ──
    info "Remote backend — no local model server install needed"

    # Install Qdrant locally (arch-aware, same as Ollama path)
    if ! command -v qdrant &>/dev/null && ! [ -x "${HOME}/.qdrant/bin/qdrant" ]; then
      if [[ "$(uname)" == "Darwin" ]]; then
        _ensure_brew
        info "Installing Qdrant via Homebrew..."
        brew install qdrant 2>/dev/null || warn "Could not install Qdrant via brew — install manually"
      else
        info "Installing Qdrant binary..."
        mkdir -p "${HOME}/.qdrant/bin"
        ARCH=$(uname -m)
        QDRANT_VER=$(curl -sf "https://api.github.com/repos/qdrant/qdrant/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
        curl -fsSL "https://github.com/qdrant/qdrant/releases/download/${QDRANT_VER}/qdrant-${ARCH}-unknown-linux-gnu.tar.gz" \
          | tar -xz -C "${HOME}/.qdrant/bin/"
        chmod +x "${HOME}/.qdrant/bin/qdrant"
        info "Qdrant ${QDRANT_VER} → ${HOME}/.qdrant/bin/qdrant"
      fi
    else
      info "Qdrant already installed"
    fi
  fi

  # ── 2. Model selection ────────────────────────────────────────────────────────
  lane "Picking brains 🧠"

  # Detect installed models in HuggingFace cache (vllm-mlx path)
  HF_CACHE="${HF_HOME:-${HOME}/.cache/huggingface}/hub"
  _model_cached() {
    local slug; slug="models--$(echo "$1" | sed 's|/|--|g')"
    [ -d "${HF_CACHE}/${slug}" ]
  }

  # vllm-mlx model lists (Apple Silicon)
  VLLM_LLM_MODELS=(
    "mlx-community/Llama-3.2-3B-Instruct-4bit|Llama 3.2 3B (default, fast, 2GB)"
    "mlx-community/Llama-3.2-1B-Instruct-4bit|Llama 3.2 1B (tiny, 0.7GB)"
    "mlx-community/Mistral-7B-Instruct-v0.3-4bit|Mistral 7B (powerful, 4GB)"
    "mlx-community/Qwen3-4B-4bit|Qwen3 4B (balanced, 2.5GB)"
    "mlx-community/Qwen3-8B-4bit|Qwen3 8B (strong reasoning, 5GB)"
  )
  VLLM_EMBED_MODELS=(
    "mlx-community/nomicai-modernbert-embed-base-8bit|ModernBERT Embed 8-bit (default, 768 dims, best quality)"
    "mlx-community/nomicai-modernbert-embed-base-4bit|ModernBERT Embed 4-bit (smaller, 768 dims)"
    "mlx-community/all-MiniLM-L6-v2-4bit|MiniLM L6 (fast, 384 dims)"
  )

  # Ollama model lists (Linux / Intel Mac)
  OLLAMA_LLM_MODELS=(
    "llama3.2:3b|Llama 3.2 3B (default, fast, 2GB)"
    "llama3.2:1b|Llama 3.2 1B (tiny, 0.7GB)"
    "mistral:7b|Mistral 7B (powerful, 4GB)"
    "qwen3:4b|Qwen3 4B (balanced, 2.5GB)"
    "qwen3:8b|Qwen3 8B (strong reasoning, 5.2GB)"
  )
  OLLAMA_EMBED_MODELS=(
    "nomic-embed-text|Nomic Embed Text (default, 768 dims, best quality)"
    "mxbai-embed-large|MXBai Embed Large (1024 dims — requires collection recreate)"
    "all-minilm:22m|MiniLM (384 dims — requires collection recreate)"
  )

  # Helper: fetch model IDs from a remote OpenAI-compat server
  _fetch_remote_models() {
    if ! command -v python3 &>/dev/null; then return 0; fi
    curl -sf "${XGH_REMOTE_URL}/v1/models" 2>/dev/null \
      | python3 -c "import json,sys; [print(m['id'] + '|' + m['id']) for m in json.load(sys.stdin).get('data',[])]" \
      2>/dev/null || true
  }

  # Select active arrays and availability helper based on backend
  if [ "$XGH_BACKEND" = "vllm-mlx" ]; then
    LLM_MODELS=("${VLLM_LLM_MODELS[@]}")
    EMBED_MODELS=("${VLLM_EMBED_MODELS[@]}")
    CUSTOM_LABEL="HuggingFace model ID"
    _model_available() { _model_cached "$1"; }
  elif [ "$XGH_BACKEND" = "remote" ]; then
    # Try to auto-populate from remote server
    CUSTOM_LABEL="Model ID (as reported by remote server)"
    _model_available() {
      command -v python3 &>/dev/null || return 1
      curl -sf "${XGH_REMOTE_URL}/v1/models" 2>/dev/null \
        | python3 -c "
import json,sys
data=json.load(sys.stdin)
ids=[m['id'] for m in data.get('data',[])]
print('yes' if '${1}' in ids else 'no')
" 2>/dev/null | grep -q "^yes"
    }
    # Try to populate model lists from remote server
    _REMOTE_MODELS=""
    if [ -n "$XGH_REMOTE_URL" ] && curl -sf --max-time 5 "${XGH_REMOTE_URL}/v1/models" >/dev/null 2>&1; then
      _REMOTE_MODELS=$(_fetch_remote_models)
    fi
    if [ -n "$_REMOTE_MODELS" ]; then
      IFS=$'\n' read -r -d '' -a LLM_MODELS <<< "$_REMOTE_MODELS" || true
      IFS=$'\n' read -r -d '' -a EMBED_MODELS <<< "$_REMOTE_MODELS" || true
      info "Loaded $(echo "$_REMOTE_MODELS" | wc -l | tr -d ' ') model(s) from remote server"
    else
      # Fall back to vllm-mlx list as reference
      LLM_MODELS=("${VLLM_LLM_MODELS[@]}")
      EMBED_MODELS=("${VLLM_EMBED_MODELS[@]}")
      warn "Could not fetch models from remote server — showing vllm-mlx reference list"
    fi
  else
    LLM_MODELS=("${OLLAMA_LLM_MODELS[@]}")
    EMBED_MODELS=("${OLLAMA_EMBED_MODELS[@]}")
    CUSTOM_LABEL="Ollama model name (e.g. llama3.2:3b)"
    _model_available() { ollama list 2>/dev/null | grep -q "^${1}[[:space:]]"; }
  fi

  # Reorder model lists: installed models first, suggestions after
  _sort_installed_first() {
    local _installed=() _rest=()
    for _entry in "$@"; do
      IFS='|' read -r _mid _ <<< "$_entry"
      if _model_available "$_mid"; then
        _installed+=("$_entry")
      else
        _rest+=("$_entry")
      fi
    done
    printf '%s\n' "${_installed[@]+"${_installed[@]}"}" "${_rest[@]+"${_rest[@]}"}"
  }
  _sorted=()
  while IFS= read -r _e; do _sorted+=("$_e"); done < <(_sort_installed_first "${LLM_MODELS[@]}")
  LLM_MODELS=("${_sorted[@]}")
  _sorted=()
  while IFS= read -r _e; do _sorted+=("$_e"); done < <(_sort_installed_first "${EMBED_MODELS[@]}")
  EMBED_MODELS=("${_sorted[@]}")
  unset _sorted _e

  if [ "$XGH_BACKEND" = "vllm-mlx" ]; then
    ORIG_DEFAULT_LLM="mlx-community/Llama-3.2-3B-Instruct-4bit"
    ORIG_DEFAULT_EMBED="mlx-community/nomicai-modernbert-embed-base-8bit"
  elif [ "$XGH_BACKEND" = "remote" ]; then
    # Default to first item in the list
    IFS='|' read -r ORIG_DEFAULT_LLM _ <<< "${LLM_MODELS[0]}"
    IFS='|' read -r ORIG_DEFAULT_EMBED _ <<< "${EMBED_MODELS[0]}"
  else
    ORIG_DEFAULT_LLM="llama3.2:3b"
    ORIG_DEFAULT_EMBED="nomic-embed-text"
  fi

  # Read currently configured models from existing cipher.yml (if present)
  CURRENT_LLM=""
  CURRENT_EMBED=""
  if [ -f "${HOME}/.cipher/cipher.yml" ]; then
    CURRENT_LLM=$(awk '/^llm:$/{f=1;next} f && /^[^[:space:]]/{exit} f && /model:/{sub(/.*model:[[:space:]]*/,""); print; exit}' "${HOME}/.cipher/cipher.yml" 2>/dev/null || true)
    CURRENT_EMBED=$(awk '/^embedding:$/{f=1;next} f && /^[^[:space:]]/{exit} f && /model:/{sub(/.*model:[[:space:]]*/,""); print; exit}' "${HOME}/.cipher/cipher.yml" 2>/dev/null || true)
  fi

  # Prefer an already-installed model as the default (current config wins, then first installed)
  DEFAULT_LLM="${CURRENT_LLM:-$ORIG_DEFAULT_LLM}"
  for entry in "${LLM_MODELS[@]}"; do
    IFS='|' read -r mid _ <<< "$entry"
    if [ "$mid" = "$CURRENT_LLM" ]; then
      DEFAULT_LLM="$mid"
      break
    fi
  done
  if [ -z "$CURRENT_LLM" ]; then
    for entry in "${LLM_MODELS[@]}"; do
      IFS='|' read -r mid _ <<< "$entry"
      if _model_available "$mid"; then
        DEFAULT_LLM="$mid"
        break
      fi
    done
  fi

  DEFAULT_EMBED="${CURRENT_EMBED:-$ORIG_DEFAULT_EMBED}"
  if [ -z "$CURRENT_EMBED" ]; then
    for entry in "${EMBED_MODELS[@]}"; do
      IFS='|' read -r mid _ <<< "$entry"
      if _model_available "$mid"; then
        DEFAULT_EMBED="$mid"
        break
      fi
    done
  fi

  # Find the 1-based index of the default model in a list
  _default_index() {
    local default_id="$1"; shift
    local idx=1
    for entry in "$@"; do
      IFS='|' read -r mid _ <<< "$entry"
      if [ "$mid" = "$default_id" ]; then
        echo "$idx"
        return
      fi
      idx=$((idx + 1))
    done
    echo "1"
  }

  DEFAULT_LLM_IDX=$(_default_index "$DEFAULT_LLM" "${LLM_MODELS[@]}")
  DEFAULT_EMBED_IDX=$(_default_index "$DEFAULT_EMBED" "${EMBED_MODELS[@]}")

  # Interactive model picker (skip if env vars are set)
  if [ -z "$XGH_LLM_MODEL" ]; then
    echo ""
    echo -e "  ${BOLD}Pick an LLM${NC} ${DIM}(Cipher's reasoning brain)${NC}"
    echo ""
    for i in "${!LLM_MODELS[@]}"; do
      IFS='|' read -r model_id model_desc <<< "${LLM_MODELS[$i]}"
      local_tag=""
      if [ -n "$CURRENT_LLM" ] && [ "$model_id" = "$CURRENT_LLM" ]; then
        if _model_available "$model_id"; then
          local_tag=" ${CYAN}(current)${NC} ${GREEN}(installed)${NC}"
        else
          local_tag=" ${CYAN}(current)${NC}"
        fi
      elif _model_available "$model_id"; then
        local_tag=" ${GREEN}(installed)${NC}"
      fi
      if [ "$model_id" = "$DEFAULT_LLM" ]; then
        echo -e "    ${GREEN}$((i+1)))${NC} ${model_desc}${local_tag}"
      else
        echo -e "    $((i+1))) ${model_desc}${local_tag}"
      fi
    done
    echo "    c) Custom ${CUSTOM_LABEL}"
    echo ""
    if [ -t 0 ]; then
      read -r -p "  Pick [${DEFAULT_LLM_IDX}]: " llm_choice
    fi
    llm_choice="${llm_choice:-$DEFAULT_LLM_IDX}"

    if [ "$llm_choice" = "c" ] || [ "$llm_choice" = "C" ]; then
      if [ -t 0 ]; then
        read -r -p "  Enter ${CUSTOM_LABEL}: " XGH_LLM_MODEL
      fi
    elif [ "$llm_choice" -ge 1 ] 2>/dev/null && [ "$llm_choice" -le "${#LLM_MODELS[@]}" ]; then
      IFS='|' read -r XGH_LLM_MODEL _ <<< "${LLM_MODELS[$((llm_choice-1))]}"
    else
      XGH_LLM_MODEL="$DEFAULT_LLM"
    fi
  fi
  XGH_LLM_MODEL="${XGH_LLM_MODEL:-$DEFAULT_LLM}"

  if [ -z "$XGH_EMBED_MODEL" ]; then
    echo ""
    echo -e "  ${BOLD}Pick an embedding model${NC} ${DIM}(semantic search engine)${NC}"
    echo ""
    for i in "${!EMBED_MODELS[@]}"; do
      IFS='|' read -r model_id model_desc <<< "${EMBED_MODELS[$i]}"
      local_tag=""
      if [ -n "$CURRENT_EMBED" ] && [ "$model_id" = "$CURRENT_EMBED" ]; then
        if _model_available "$model_id"; then
          local_tag=" ${CYAN}(current)${NC} ${GREEN}(installed)${NC}"
        else
          local_tag=" ${CYAN}(current)${NC}"
        fi
      elif _model_available "$model_id"; then
        local_tag=" ${GREEN}(installed)${NC}"
      fi
      if [ "$model_id" = "$DEFAULT_EMBED" ]; then
        echo -e "    ${GREEN}$((i+1)))${NC} ${model_desc}${local_tag}"
      else
        echo -e "    $((i+1))) ${model_desc}${local_tag}"
      fi
    done
    echo "    c) Custom ${CUSTOM_LABEL}"
    echo ""
    if [ -t 0 ]; then
      read -r -p "  Pick [${DEFAULT_EMBED_IDX}]: " embed_choice
    fi
    embed_choice="${embed_choice:-$DEFAULT_EMBED_IDX}"

    if [ "$embed_choice" = "c" ] || [ "$embed_choice" = "C" ]; then
      if [ -t 0 ]; then
        read -r -p "  Enter ${CUSTOM_LABEL}: " XGH_EMBED_MODEL
      fi
    elif [ "$embed_choice" -ge 1 ] 2>/dev/null && [ "$embed_choice" -le "${#EMBED_MODELS[@]}" ]; then
      IFS='|' read -r XGH_EMBED_MODEL _ <<< "${EMBED_MODELS[$((embed_choice-1))]}"
    else
      XGH_EMBED_MODEL="$DEFAULT_EMBED"
    fi
  fi
  XGH_EMBED_MODEL="${XGH_EMBED_MODEL:-$DEFAULT_EMBED}"

  # Warn if non-768-dim embed model selected on Ollama (existing collections are 768-dim)
  if [ "$XGH_BACKEND" = "ollama" ] && [[ "$XGH_EMBED_MODEL" != "nomic-embed-text" ]]; then
    warn "Non-768-dim embed model selected. Existing 768-dim Qdrant collections will be incompatible."
    warn "  Run with XGH_RESET_COLLECTION=1 if you want to recreate collections."
  fi

  info "LLM model:       ${XGH_LLM_MODEL}"
  info "Embedding model:  ${XGH_EMBED_MODEL}"

  # ── 3. cipher.yml generation ──────────────────────────────────────────────────
  lane "Wiring up the memory layer 🧬"

  # -- cipher.yml (cipher agent config with correct models and endpoints) --
  CIPHER_YML="${HOME}/.cipher/cipher.yml"
  if [ ! -f "$CIPHER_YML" ]; then
    info "Generating cipher.yml"
    mkdir -p "${HOME}/.cipher"
    if [ "$XGH_BACKEND" = "vllm-mlx" ]; then
      cat > "$CIPHER_YML" <<CIPHERYMLEOF
mcpServers: {}

llm:
  provider: openai
  model: ${XGH_LLM_MODEL}
  maxIterations: 50
  apiKey: placeholder
  baseURL: http://localhost:${XGH_MODEL_PORT}/v1

embedding:
  type: openai
  model: ${XGH_EMBED_MODEL}
  apiKey: placeholder
  baseURL: http://localhost:${XGH_MODEL_PORT}/v1
  dimensions: 768

systemPrompt:
  enabled: true
  content: |
    You are an AI programming assistant focused on coding and reasoning tasks. You excel at:
    - Writing clean, efficient code
    - Debugging and problem-solving
    - Code review and optimization
    - Explaining complex technical concepts
    - Reasoning through programming challenges
CIPHERYMLEOF
    elif [ "$XGH_BACKEND" = "remote" ]; then
      cat > "$CIPHER_YML" <<CIPHERYMLEOF
mcpServers: {}

llm:
  provider: openai
  model: ${XGH_LLM_MODEL}
  maxIterations: 50
  apiKey: placeholder
  baseURL: ${XGH_REMOTE_URL}/v1

embedding:
  type: openai
  model: ${XGH_EMBED_MODEL}
  apiKey: placeholder
  baseURL: ${XGH_REMOTE_URL}/v1
  dimensions: 768

systemPrompt:
  enabled: true
  content: |
    You are an AI programming assistant focused on coding and reasoning tasks. You excel at:
    - Writing clean, efficient code
    - Debugging and problem-solving
    - Code review and optimization
    - Explaining complex technical concepts
    - Reasoning through programming challenges
CIPHERYMLEOF
    else
      # Ollama backend: use native Ollama provider/type (no OpenAI-compat shim needed)
      cat > "$CIPHER_YML" <<CIPHERYMLEOF
mcpServers: {}

llm:
  provider: ollama
  model: ${XGH_LLM_MODEL}
  maxIterations: 50
  baseURL: http://localhost:${XGH_MODEL_PORT}

embedding:
  type: ollama
  model: ${XGH_EMBED_MODEL}
  baseURL: http://localhost:${XGH_MODEL_PORT}
  dimensions: 768

systemPrompt:
  enabled: true
  content: |
    You are an AI programming assistant focused on coding and reasoning tasks. You excel at:
    - Writing clean, efficient code
    - Debugging and problem-solving
    - Code review and optimization
    - Explaining complex technical concepts
    - Reasoning through programming challenges
CIPHERYMLEOF
    fi
    info "cipher.yml → ${CIPHER_YML}"
  else
    # Update model names (and provider/type) in existing cipher.yml to match current selection
    info "cipher.yml exists — syncing model names and backend"
    if command -v python3 &>/dev/null; then
      python3 - "$CIPHER_YML" "$XGH_LLM_MODEL" "$XGH_EMBED_MODEL" "$XGH_MODEL_PORT" "$XGH_BACKEND" "${XGH_REMOTE_URL:-}" <<'SYNCEOF'
import sys, re
path, llm_model, embed_model, port, backend, remote_url = sys.argv[1:]
content = open(path).read()
# Update embedding model
content = re.sub(r'(^embedding:.*?^\s+model:\s*)(\S+)', lambda m: m.group(1) + embed_model, content, flags=re.MULTILINE|re.DOTALL, count=1)
# Update LLM model (only under llm: section, not embedding:)
content = re.sub(r'(^llm:.*?^\s+model:\s*)(\S+)', lambda m: m.group(1) + llm_model, content, flags=re.MULTILINE|re.DOTALL, count=1)
# Update baseURLs based on backend
if backend == 'remote':
    # Replace any existing baseURL (localhost or otherwise) with remote URL
    content = re.sub(r'(baseURL:\s*)(\S+)', lambda m: m.group(1) + remote_url + '/v1', content)
    # Update provider and type to openai
    content = re.sub(r'(^llm:.*?^\s+provider:\s*)(\S+)', lambda m: m.group(1) + 'openai', content, flags=re.MULTILINE|re.DOTALL, count=1)
    content = re.sub(r'(^embedding:.*?^\s+type:\s*)(\S+)', lambda m: m.group(1) + 'openai', content, flags=re.MULTILINE|re.DOTALL, count=1)
elif backend == 'vllm-mlx':
    content = re.sub(r'(baseURL:\s*http://localhost:)\d+(/v1)', lambda m: m.group(1) + port + m.group(2), content)
    content = re.sub(r'(baseURL:\s*http://localhost:)\d+(?!/v1)', lambda m: m.group(1) + port + '/v1', content)
    # Update provider and type to openai
    content = re.sub(r'(^llm:.*?^\s+provider:\s*)(\S+)', lambda m: m.group(1) + 'openai', content, flags=re.MULTILINE|re.DOTALL, count=1)
    content = re.sub(r'(^embedding:.*?^\s+type:\s*)(\S+)', lambda m: m.group(1) + 'openai', content, flags=re.MULTILINE|re.DOTALL, count=1)
else:
    content = re.sub(r'(baseURL:\s*http://localhost:)\d+(?:/v1)?', lambda m: m.group(1) + port, content)
    # Update provider and type to ollama
    content = re.sub(r'(^llm:.*?^\s+provider:\s*)(\S+)', lambda m: m.group(1) + 'ollama', content, flags=re.MULTILINE|re.DOTALL, count=1)
    content = re.sub(r'(^embedding:.*?^\s+type:\s*)(\S+)', lambda m: m.group(1) + 'ollama', content, flags=re.MULTILINE|re.DOTALL, count=1)
open(path, 'w').write(content)
print(f'  synced: llm={llm_model} embed={embed_model} backend={backend}' + (f' remote={remote_url}' if remote_url else f' port={port}'))
SYNCEOF
    else
      warn "python3 not found — cipher.yml model sync skipped (models may be stale in existing config)"
    fi
  fi

fi
