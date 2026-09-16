#!/bin/sh
# CoderVibes, the open-source edition: installs it, starts it on this machine,
# and points the coding agents here at it.
#
#   curl -fsSL codervibes.io/local.sh | sh
#     [--dir <path>] [--port <n>] [--yes] [--no-setup] [--no-start]
#
# Clones
#   https://github.com/codervibes-io/codervibes
# into $HOME/.codervibes/app, installs its dependencies, starts it on
# 127.0.0.1 and runs that installation's own setup line, so Claude Code, Codex
# and Gemini CLI on this machine report to it. It holds no secret and asks for
# none: the local edition answers on this machine only and has nobody to
# authenticate.
#
# Six steps, and each one says what it found and asks before it does anything
# about it - Enter is yes, "n" stops. A step with nothing left to do says so
# and is skipped, which is what makes running this again cheap: it is the way
# to update, and a run that stopped halfway carries on from where it stopped.
# --yes answers every step, for a machine with nobody in front of it.
#
# It stops only the server it started itself, by the pid in
# ~/.codervibes/local.pid, and never frees a port by killing what holds it.
# It does not arrange for CoderVibes to come back after a reboot: a login item
# on macOS or a systemd user unit on Linux is your own call to make.
set -eu

REPO="https://github.com/codervibes-io/codervibes"
DIR="$HOME/.codervibes/app"
PORT="${PORT:-3592}"
SETUP=1
START=1
YES=0
# Answers come from the terminal, not from stdin: stdin is this script,
# arriving down the pipe from curl. CODERVIBES_INSTALL_TTY is how the test
# suite answers the questions and is for nothing else.
TTY="${CODERVIBES_INSTALL_TTY:-/dev/tty}"

# The OpenTelemetry variables belong to the coding agents on this machine,
# which step 5 points at this server. This shell has them because the env
# file step 5 wrote is sourced by every shell afterwards, and handing them to
# the server would tell it to export its own spans to its own door.
# server/local.js drops them itself, which is the fix; this is the belt to
# its braces, and it is what stands between a checkout from before that fix
# and a server that starts and dies.
NOEXPORT="env -u OTEL_EXPORTER_OTLP_ENDPOINT -u OTEL_EXPORTER_OTLP_HEADERS -u OTEL_EXPORTER_OTLP_PROTOCOL -u CLAUDE_CODE_ENABLE_TELEMETRY"

usage() { echo "usage: local.sh [--dir <path>] [--port <n>] [--yes] [--no-setup] [--no-start]" >&2; }

# Whether a pid is a process that is still running. `kill -0` is not enough
# on its own: a container with no init reaps nothing, so the server this
# script started stays a <defunct> entry that answers `kill -0` forever -
# and every re-run then sat through the whole ten-second stop loop and
# announced a dead server as running. Linux says so in /proc; where there is
# no /proc (macOS, a BSD) the pid is taken at its word, which is what this
# did everywhere before. CODERVIBES_INSTALL_PROC is how the test suite hands
# it a /proc of its own and is for nothing else.
alive() {
  [ -n "${1:-}" ] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  proc="${CODERVIBES_INSTALL_PROC:-/proc}"
  if [ -r "$proc/$1/status" ] && grep -q '^State:[	 ]*Z' "$proc/$1/status" 2>/dev/null; then return 1; fi
  return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || { usage; exit 2; }; DIR="$2"; shift 2 ;;
    --dir=*) DIR="${1#--dir=}"; shift ;;
    --port) [ $# -ge 2 ] || { usage; exit 2; }; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    -y|--yes) YES=1; shift ;;
    --no-setup) SETUP=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "local.sh: unknown argument '$1'" >&2; usage; exit 2 ;;
  esac
done

CV="${HOME:?HOME is not set}/.codervibes"
PIDFILE="$CV/local.pid"
LOG="$CV/local.log"
URL="http://127.0.0.1:$PORT"
mkdir -p "$CV"

step() { echo; echo "$*"; }
note() { echo "  $*"; }
warn() { echo "  $*" >&2; }

echo "CoderVibes, the open-source edition. Six steps, each one asked about first."
if [ "$YES" = 1 ]; then
  note "Answering yes to every step (--yes)."
elif ! (exec 3<"$TTY") 2>/dev/null; then
  YES=1
  note "There is no terminal here to ask on, so every step is taken as agreed."
fi

# Enter is yes; "n" stops, here, with nothing after this point touched.
ask() {
  if [ "$YES" = 1 ]; then note "$1 yes"; return 0; fi
  printf '  %s [Y/n] ' "$1"
  answer=""
  read -r answer < "$TTY" || answer=""
  case "$answer" in
    [Nn]*) note "Stopped. Nothing past this step was changed - run the same line again to carry on."; exit 0 ;;
  esac
}

# --------------------------------------------------------- 1. what it needs
step "1. What this needs"
have=$(node -v 2>/dev/null || true)
major=${have#v}; major=${major%%.*}
case "$major" in "" | *[!0-9]*) major=0 ;; esac
if [ "$major" -lt 24 ]; then
  warn "Node ${have:-is not on this PATH} - CoderVibes needs 24 or newer."
  warn "Install it from https://nodejs.org, or run: brew install node   (or: nvm install 24)"
  exit 2
fi
for tool in git curl; do
  command -v "$tool" >/dev/null 2>&1 || { warn "$tool is not on this PATH, and this needs it."; exit 2; }
done
note "Node $have, git and curl are all here - nothing to do."

# ------------------------------------------------------------- 2. the code
step "2. The code"
if [ -d "$DIR/.git" ] && [ "$(git -C "$DIR" remote get-url origin 2>/dev/null || true)" = "$REPO" ]; then
  note "$DIR is already a checkout of this."
  git -C "$DIR" fetch --quiet origin
  behind=$(git -C "$DIR" rev-list --count HEAD..FETCH_HEAD 2>/dev/null || echo 0)
  if [ "$behind" = 0 ]; then
    note "It is up to date - nothing to do."
  else
    ask "$behind newer commit(s) than this checkout. Update it?"
    git -C "$DIR" merge --ff-only FETCH_HEAD >/dev/null
    note "Updated."
  fi
elif [ -e "$DIR" ]; then
  note "$DIR is here and is not a checkout of $REPO."
  aside="$DIR.bak-$(date +%Y%m%d-%H%M%S)"
  ask "Move it aside to $aside and clone fresh? (nothing is deleted)"
  mv "$DIR" "$aside"
  git clone --quiet --depth 1 "$REPO" "$DIR"
  note "Cloned. What was there is at $aside."
else
  note "There is nothing at $DIR yet."
  ask "Clone $REPO into it?"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --depth 1 "$REPO" "$DIR"
  note "Cloned."
fi

# ----------------------------------------------------- 3. its dependencies
# </dev/null on npm: this script is usually itself on stdin, from the curl
# that fetched it, and a child that reads stdin eats the rest of the script.
step "3. Its dependencies"
install_them() { (cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error </dev/null); note "Installed."; }
if [ ! -d "$DIR/node_modules" ]; then
  note "They are not installed yet."
  ask "Run npm install in $DIR?"
  install_them
elif [ "$DIR/package.json" -nt "$DIR/node_modules" ]; then
  note "package.json is newer than what is installed."
  ask "Install again?"
  install_them
else
  note "Already installed - nothing to do."
fi

# ----------------------------------------------------------- 4. the server
step "4. The server"
if [ "$START" = 0 ]; then
  note "Not starting it (--no-start). Start it with: PORT=$PORT node $DIR/server/local.js"
else
  running=""
  if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null || true)
    if alive "$old"; then
      running="$old"
    else
      rm -f "$PIDFILE"
      note "A pid file was left behind by a CoderVibes that is no longer running; removed it."
    fi
  fi
  if [ -n "$running" ]; then
    note "The CoderVibes this script started is running (pid $running)."
    ask "Restart it on the code above?"
    kill "$running" 2>/dev/null || true
    n=0
    while alive "$running" && [ $n -lt 10 ]; do n=$((n + 1)); sleep 1; done
    rm -f "$PIDFILE"
    note "Stopped it."
  elif curl -s -o /dev/null -m 2 "$URL/" 2>/dev/null; then
    # Somebody else's. A port is shared, and a script that frees one by
    # killing what holds it is a script that killed somebody's work.
    warn "Something is already listening on $PORT, and it is not one this script started."
    case "$(uname -s 2>/dev/null || echo unknown)" in
      Darwin) warn "See what it is:  lsof -i :$PORT" ;;
      *) warn "See what it is:  ss -ltnp \"sport = :$PORT\"" ;;
    esac
    warn "Stop it yourself if it is yours to stop, or run this line again with --port <n>."
    exit 1
  else
    ask "Start CoderVibes on $URL?"
  fi
  PORT="$PORT" nohup $NOEXPORT node "$DIR/server/local.js" > "$LOG" 2>&1 </dev/null &
  echo $! > "$PIDFILE"
  n=0; up=0
  while [ $n -lt 15 ]; do
    if curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1; then up=1; break; fi
    n=$((n + 1)); sleep 1
  done
  if [ "$up" = 0 ]; then
    warn "It did not answer at $URL/healthz within 15s. The end of $LOG:"
    tail -n 20 "$LOG" >&2
    exit 1
  fi
  note "Running on $URL (pid $(cat "$PIDFILE"))."
fi

# ------------------------------------------------- 5. the agents on this machine
# The installation's own setup line, run against the installation that is
# now up: it is the one that knows what it carries (no token here, and its
# three MCP tools), so this asks it rather than writing a second copy.
step "5. The coding agents on this machine"
if [ "$SETUP" = 0 ]; then
  note "Leaving them alone (--no-setup). The line is: curl -fsSL $URL/setup.sh | sh"
elif [ "$START" = 0 ]; then
  note "Nothing is running for them to report to. Once it is: curl -fsSL $URL/setup.sh | sh"
elif grep -qs "CODERVIBES_ORIGIN=\"$URL\"" "$CV/env" && grep -qs '.codervibes/report' "$HOME/.claude/settings.json"; then
  note "They already report to $URL - nothing to do."
else
  note "This points whichever of them are here at $URL, and replaces nothing else."
  ask "Connect Claude Code, Codex and Gemini CLI on this machine?"
  curl -fsSL "$URL/setup.sh" | sh || warn "Could not connect them - run: curl -fsSL $URL/setup.sh | sh"
fi

# --------------------------------------------------------- 6. where it is
step "6. Where it all is"
if [ "$START" = 0 ]; then
  cat <<EOF
  installed   $DIR
  start it    PORT=$PORT node $DIR/server/local.js
EOF
else
  cat <<EOF
  CoderVibes  $URL
  stop        kill \$(cat $PIDFILE)
  start again PORT=$PORT node $DIR/server/local.js   (or run this line again: it updates, then restarts)
  records     $CV/data  (back that up; nothing else will)
  log         $LOG
EOF
fi
