#!/usr/bin/env bash
set -Eeuo pipefail

LABEL="dev.rootoperator.restart"
LOG_PATH="${RO_DEV_LOG:-/tmp/ro-dev.log}"
PORT_TIMEOUT_SECONDS="${RO_DEV_PORT_TIMEOUT_SECONDS:-20}"
GRACE_SECONDS="${RO_DEV_GRACE_SECONDS:-4}"
PORTS=(5173 5174)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"
REPO_DIR="${RO_DEV_REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd -P)}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*"
}

xml_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    <<<"$1"
}

write_plist() {
  mkdir -p "${HOME}/Library/LaunchAgents" "$(dirname "${LOG_PATH}")"

  local escaped_label escaped_script escaped_repo escaped_log escaped_path
  escaped_label="$(xml_escape "${LABEL}")"
  escaped_script="$(xml_escape "${SCRIPT_PATH}")"
  escaped_repo="$(xml_escape "${REPO_DIR}")"
  escaped_log="$(xml_escape "${LOG_PATH}")"
  escaped_path="$(xml_escape "/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

  local tmp_plist
  tmp_plist="${PLIST}.$$"
  cat >"${tmp_plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escaped_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${escaped_script}</string>
    <string>--worker</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escaped_repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escaped_path}</string>
    <key>RO_DEV_REPO_DIR</key>
    <string>${escaped_repo}</string>
    <key>RO_DEV_LOG</key>
    <string>${escaped_log}</string>
    <key>RO_AUTO_START_TUNNEL</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escaped_log}</string>
  <key>StandardErrorPath</key>
  <string>${escaped_log}</string>
</dict>
</plist>
EOF
  /usr/bin/plutil -lint "${tmp_plist}" >/dev/null
  mv "${tmp_plist}" "${PLIST}"
}

service_target() {
  printf 'gui/%s/%s' "${UID}" "${LABEL}"
}

service_domain() {
  printf 'gui/%s' "${UID}"
}

service_loaded() {
  /bin/launchctl print "$(service_target)" >/dev/null 2>&1
}

trigger_restart() {
  mkdir -p "$(dirname "${LOG_PATH}")"
  : >"${LOG_PATH}"
  write_plist
  /bin/launchctl enable "$(service_target)" >/dev/null 2>&1 || true

  if service_loaded; then
    log "Restarting loaded LaunchAgent ${LABEL}." | tee -a "${LOG_PATH}"
    /bin/launchctl kickstart -k "$(service_target)"
  else
    log "Bootstrapping LaunchAgent ${LABEL}." | tee -a "${LOG_PATH}"
    /bin/launchctl bootstrap "$(service_domain)" "${PLIST}"
  fi

  log "Restart handed to launchd. Log: ${LOG_PATH}" | tee -a "${LOG_PATH}"
}

current_pgid() {
  ps -o pgid= -p "$1" 2>/dev/null | tr -d '[:space:]'
}

kill_pgid() {
  local pgid="$1"
  local self_pgid
  self_pgid="$(current_pgid "$$")"

  if [[ ! "${pgid}" =~ ^[0-9]+$ ]] || [[ "${pgid}" -le 1 ]]; then
    return 0
  fi

  if [[ "${pgid}" == "${self_pgid}" ]]; then
    log "Skipping process group ${pgid}; it is this worker's process group."
    return 0
  fi

  log "Sending TERM to process group ${pgid}."
  kill -TERM -- "-${pgid}" 2>/dev/null || true
}

kill_pids_by_cwd_pattern() {
  local pattern="$1"
  local pid cwd

  pgrep -f "${pattern}" 2>/dev/null | while IFS= read -r pid; do
    [[ -z "${pid}" || "${pid}" == "$$" ]] && continue
    cwd="$(/usr/sbin/lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    [[ -z "${cwd}" ]] && continue

    if [[ "${cwd}" == "${REPO_DIR}" || "${cwd}" == "${REPO_DIR}/"* ]]; then
      log "Sending TERM to PID ${pid} (${pattern}) in ${cwd}."
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done
}

kill_existing_tree() {
  local pid pgid pgids
  pgids=""

  log "Looking for existing Root_Operator dev process groups."
  pgrep -f 'concurrently.*dev:renderer.*dev:client' 2>/dev/null | while IFS= read -r pid; do
    pgid="$(current_pgid "${pid}")"
    [[ -z "${pgid}" ]] && continue

    case " ${pgids} " in
      *" ${pgid} "*) ;;
      *)
        pgids="${pgids} ${pgid}"
        kill_pgid "${pgid}"
        ;;
    esac
  done

  # CWD filtering keeps these fallbacks from killing other projects' dev servers.
  kill_pids_by_cwd_pattern 'npm.*run.*dev:app'
  kill_pids_by_cwd_pattern 'concurrently.*dev:renderer'
  kill_pids_by_cwd_pattern 'vite.*vite\.client\.config\.js'
  kill_pids_by_cwd_pattern 'vite.*vite\.renderer\.config\.js'
  kill_pids_by_cwd_pattern 'Electron'
  kill_pids_by_cwd_pattern 'claude'

  log "Waiting ${GRACE_SECONDS}s for process cleanup."
  sleep "${GRACE_SECONDS}"
}

port_listener_pids() {
  local port
  for port in "${PORTS[@]}"; do
    /usr/sbin/lsof -nP -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
  done | sort -u
}

wait_for_ports() {
  local deadline pids pid
  deadline=$((SECONDS + PORT_TIMEOUT_SECONDS))

  while true; do
    pids="$(port_listener_pids)"
    [[ -z "${pids}" ]] && return 0
    [[ "${SECONDS}" -ge "${deadline}" ]] && break

    log "Waiting for dev ports to free; listeners: ${pids//$'\n'/ }."
    sleep 0.5
  done

  log "Ports still held after ${PORT_TIMEOUT_SECONDS}s; sending TERM to listeners."
  for pid in ${pids}; do
    [[ "${pid}" == "$$" ]] && continue
    kill -TERM "${pid}" 2>/dev/null || true
  done

  sleep 2
  pids="$(port_listener_pids)"
  [[ -z "${pids}" ]] && return 0

  log "Ports still held; sending KILL to listeners: ${pids//$'\n'/ }."
  for pid in ${pids}; do
    [[ "${pid}" == "$$" ]] && continue
    kill -KILL "${pid}" 2>/dev/null || true
  done
}

load_node_environment() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

  set +u
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)" >/dev/null 2>&1 || true
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)" >/dev/null 2>&1 || true
  fi

  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "${HOME}/.nvm/nvm.sh"
    if [[ -f "${REPO_DIR}/.nvmrc" ]]; then
      nvm use --silent >/dev/null 2>&1 || true
    fi
  fi

  if [[ -s "${HOME}/.asdf/asdf.sh" ]]; then
    # shellcheck source=/dev/null
    . "${HOME}/.asdf/asdf.sh"
  fi

  if [[ -x "${HOME}/.nodenv/bin/nodenv" ]]; then
    export PATH="${HOME}/.nodenv/bin:${PATH}"
    eval "$("${HOME}/.nodenv/bin/nodenv" init -)" >/dev/null 2>&1 || true
  fi
  set -u
}

run_worker() {
  cd "${REPO_DIR}"
  log "Launchd worker PID $$ PPID ${PPID}; repo ${REPO_DIR}."

  kill_existing_tree
  wait_for_ports
  load_node_environment

  local npm_bin
  npm_bin="$(command -v npm || true)"
  if [[ -z "${npm_bin}" ]]; then
    log "npm was not found in the launchd worker environment."
    exit 127
  fi

  log "Starting npm run dev:app with ${npm_bin}."
  exec "${npm_bin}" run dev:app
}

case "${1:-}" in
  --worker)
    run_worker
    ;;
  --help|-h)
    printf 'Usage: %s\n\nInstalls/kickstarts the Root_Operator dev LaunchAgent and writes logs to %s.\n' "${SCRIPT_PATH}" "${LOG_PATH}"
    ;;
  *)
    trigger_restart
    ;;
esac
