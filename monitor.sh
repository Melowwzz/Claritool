#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════
#  Claritool Monitor — Live activity feed no terminal
# ══════════════════════════════════════════════════════════
#
#  Uso:
#    ./monitor.sh
#    ./monitor.sh --url https://seu-worker.workers.dev --key sua_secret
#
#  Variáveis de ambiente (ou flags):
#    CLARITOOL_URL    — URL base do worker
#    CLARITOOL_SECRET — Secret de autenticação do monitor
#

set -euo pipefail

# ── Config ──
URL="${CLARITOOL_URL:-}"
SECRET="${CLARITOOL_SECRET:-}"
INTERVAL=3
SINCE=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)    URL="$2";    shift 2 ;;
    --key)    SECRET="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Flag desconhecida: $1"; exit 1 ;;
  esac
done

if [[ -z "$URL" || -z "$SECRET" ]]; then
  echo ""
  echo "  Claritool Monitor"
  echo "  ─────────────────"
  echo ""
  echo "  Uso:"
  echo "    export CLARITOOL_URL=https://seu-worker.workers.dev"
  echo "    export CLARITOOL_SECRET=sua_secret_aqui"
  echo "    ./monitor.sh"
  echo ""
  echo "  Ou:"
  echo "    ./monitor.sh --url https://seu-worker.workers.dev --key sua_secret"
  echo ""
  exit 1
fi

# ── Colors ──
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
MAGENTA="\033[35m"
RED="\033[31m"
WHITE="\033[97m"
BG_BLACK="\033[40m"

clear

# ── Header ──
print_header() {
  local total="$1"
  local today="$2"
  echo -e "${BG_BLACK}${BOLD}"
  echo -e "  ╔══════════════════════════════════════════════════════════╗"
  echo -e "  ║          ${CYAN}CLARITOOL MONITOR${WHITE}  —  Live Activity Feed        ║"
  echo -e "  ╠══════════════════════════════════════════════════════════╣"
  echo -e "  ║  ${GREEN}Total: ${total}${WHITE}    ${YELLOW}Hoje: ${today}${WHITE}    ${DIM}Refresh: ${INTERVAL}s${RESET}${BOLD}${BG_BLACK}               ║"
  echo -e "  ╚══════════════════════════════════════════════════════════╝"
  echo -e "${RESET}"
}

# ── Format a single log entry ──
format_log() {
  local time="$1"
  local mode="$2"
  local model="$3"
  local vision="$4"
  local query="$5"
  local endpoint="$6"

  # Time (HH:MM:SS)
  local short_time
  short_time=$(echo "$time" | grep -oP 'T\K[0-9]{2}:[0-9]{2}:[0-9]{2}' 2>/dev/null || echo "$time")

  # Mode color
  local mode_color="$GREEN"
  case "$mode" in
    think)  mode_color="$MAGENTA" ;;
    legacy) mode_color="$DIM" ;;
  esac

  # Vision tag
  local vision_tag=""
  if [[ "$vision" == "true" ]]; then
    vision_tag=" ${RED}[IMG]${RESET}"
  fi

  # Endpoint tag
  local ep_tag=""
  if [[ "$endpoint" == "/" ]]; then
    ep_tag=" ${DIM}(legacy)${RESET}"
  fi

  # Truncate query
  local short_query
  if [[ ${#query} -gt 80 ]]; then
    short_query="${query:0:80}..."
  else
    short_query="$query"
  fi

  echo -e "  ${DIM}${short_time}${RESET}  ${mode_color}${BOLD}${mode}${RESET}  ${CYAN}${model}${RESET}${vision_tag}${ep_tag}"
  echo -e "  ${WHITE}> ${short_query}${RESET}"
  echo -e "  ${DIM}────────────────────────────────────────────────────${RESET}"
}

# ── Main loop ──
echo -e "\n  ${DIM}Conectando a ${URL}...${RESET}\n"

while true; do
  # Build URL
  FETCH_URL="${URL}/api/logs?key=${SECRET}"
  if [[ -n "$SINCE" ]]; then
    FETCH_URL="${FETCH_URL}&since=${SINCE}"
  fi

  # Fetch
  RESPONSE=$(curl -sf "$FETCH_URL" 2>/dev/null || echo '{"error":"fetch_failed"}')

  # Check errors
  if echo "$RESPONSE" | grep -q '"error"' 2>/dev/null; then
    ERR=$(echo "$RESPONSE" | grep -oP '"error"\s*:\s*"\K[^"]+' 2>/dev/null || echo "unknown")
    if [[ "$ERR" == "Unauthorized" ]]; then
      echo -e "  ${RED}ERRO: Secret invalida. Verifique CLARITOOL_SECRET.${RESET}"
      exit 1
    elif [[ "$ERR" == "fetch_failed" ]]; then
      echo -e "  ${YELLOW}(sem conexao — tentando novamente...)${RESET}"
      sleep "$INTERVAL"
      continue
    fi
  fi

  # Parse stats
  TOTAL=$(echo "$RESPONSE" | grep -oP '"total"\s*:\s*\K[0-9]+' 2>/dev/null || echo "0")
  TODAY=$(echo "$RESPONSE" | grep -oP '"today"\s*:\s*\K[0-9]+' 2>/dev/null || echo "0")

  # Parse new logs (via python for reliable JSON parsing)
  NEW_LOGS=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    logs = data.get('logs', [])
    # Print newest last (reverse since logs are newest-first)
    for l in reversed(logs):
        t = l.get('time','')
        m = l.get('mode','?')
        mo = l.get('model','?')
        v = str(l.get('vision', False)).lower()
        q = l.get('query','').replace('\n',' ').strip()
        e = l.get('endpoint','')
        print(f'{t}\t{m}\t{mo}\t{v}\t{q}\t{e}')
except:
    pass
" <<< "$RESPONSE" 2>/dev/null || true)

  # If we got new logs, display them
  if [[ -n "$NEW_LOGS" ]]; then
    clear
    print_header "$TOTAL" "$TODAY"

    LATEST_TIME=""
    while IFS=$'\t' read -r time mode model vision query endpoint; do
      format_log "$time" "$mode" "$model" "$vision" "$query" "$endpoint"
      LATEST_TIME="$time"
    done <<< "$NEW_LOGS"

    # Update SINCE to only fetch new entries next time
    if [[ -n "$LATEST_TIME" ]]; then
      SINCE="$LATEST_TIME"
    fi
  elif [[ -z "$SINCE" ]]; then
    # First run, no logs yet
    clear
    print_header "$TOTAL" "$TODAY"
    echo -e "  ${DIM}Aguardando atividade...${RESET}"
    echo ""
  fi

  sleep "$INTERVAL"
done
