// One line that puts the open-source edition on somebody's own machine.
//
// The local edition (server/local.js) has always been three commands -
// clone, `npm install`, `npm start` - and then a fourth, the setup line,
// to make the agents on the machine report to it. Four commands is three
// too many for the first thing a stranger does with this product: the
// landing page's first band is "get started", and a band that says "get
// started" and then asks somebody to read a README has not started them.
// So this is the four commands as one, and the one the site prints:
//
//   curl -fsSL codervibes.io/local.sh | sh
//
// (the site prints it with the scheme; this file names no installation -
// see `localInstallCommand` below)
//
// It is the same shape as setup-script.js and for the same reasons - plain
// POSIX sh, so it runs under the sh, zsh or bash the person happens to
// have; no secret in it, so it is public and cacheable. What it is *not* is
// a package manager: it clones a git repository and runs npm, which is what
// the README says to do by hand, in the order the README says to do it.
//
// **It looks before it does anything, and asks before each step.** Six
// steps - what it needs, the code, the dependencies, the server, the agents
// on this machine, and where it all ended up - and each one says what it
// found, says what it would do about it, and waits for a yes (owner's ask,
// 2026-09-15). A curl piped into a shell is the least legible thing a
// person can be asked to run, and the answer is not a longer README: it is
// the script narrating itself while the person watches. Enter is yes;
// `--yes` skips the asking for a machine with nobody in front of it, and so
// does having no terminal to ask on.
//
// **A step with nothing to do is said and skipped, not asked about.** That
// is also what makes this idempotent in the way that matters: there is no
// state file, because the state is on the disk - a checkout that is already
// there and current, a node_modules newer than its package.json, a pid file
// with something alive on the end of it, an env file already pointing here.
// A second run walks through in a few seconds saying "nothing to do" four
// times, and a run that stopped halfway carries on from where it stopped,
// because what it did is what it finds.
//
// **And it repairs what it finds broken, with permission.** A pid file
// whose process is gone is removed and said so. A directory that is not the
// checkout it should be is offered aside as `app.bak-<date>` rather than
// written over. A port somebody else is on is reported, with the command
// that says who has it - and never freed by killing what holds it, because
// the one thing worse than this not starting is this killing somebody's
// server.
//
// **It does not install a login item.** Whether this comes back after a
// reboot is the person's own decision and their own machine's idiom - a
// launchd plist, a systemd user unit, a line in their shell profile - and a
// curl|sh that quietly arranges to run forever is the thing that makes
// people distrust curl|sh.

/**
 * The Node the local edition needs.
 *
 * The published package.json says `>=24` - scripts/cut-local.mjs takes it
 * from this repo's `engines`, or from the Dockerfile's `FROM node:24-slim`
 * where there is none - and a script that installs the thing should refuse
 * before `npm install` does, with the sentence that fixes it rather than a
 * page of npm's. test/local-install-script.test.js holds the two together,
 * so raising the floor in one place cannot leave the other behind.
 */
export const NODE_MIN = 24;

/**
 * The line a person runs, for whoever is printing it.
 *
 * No default origin, deliberately: this module is carried into the
 * open-source cut (it is what installs it), and a hosted address baked into
 * a published file is a published file that points at somebody else's
 * installation - test/local-cut.test.js refuses one by name. The site's own
 * address belongs to the site's copy (`LOCAL` in public/console-public.js).
 */
export const localInstallCommand = ({ origin }) =>
  `curl -fsSL ${String(origin).replace(/\/+$/, "")}/local.sh | sh`;

/**
 * The script, for `GET /local.sh`.
 *
 * Every default is a flag as well, because the two things a person on a
 * shared or a tidy machine wants to change are where it lands and what
 * port it takes, and a script whose answer to that is "edit it" is a
 * script they fork.
 *
 * @param {{repo?: string, dir?: string, port?: number, node?: number}} options
 */
export function localInstallScript({
  repo = "https://github.com/codervibes-io/codervibes",
  dir = "$HOME/.codervibes/app",
  port = 3592,
  node = NODE_MIN,
} = {}) {
  return `#!/bin/sh
# CoderVibes, the open-source edition: installs it, starts it on this machine,
# and points the coding agents here at it.
#
#   curl -fsSL codervibes.io/local.sh | sh
#     [--dir <path>] [--port <n>] [--yes] [--no-setup] [--no-start]
#
# Clones
#   ${repo}
# into ${dir}, installs its dependencies, starts it on
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

REPO="${repo}"
DIR="${dir}"
PORT="\${PORT:-${port}}"
SETUP=1
START=1
YES=0
# Answers come from the terminal, not from stdin: stdin is this script,
# arriving down the pipe from curl. CODERVIBES_INSTALL_TTY is how the test
# suite answers the questions and is for nothing else.
TTY="\${CODERVIBES_INSTALL_TTY:-/dev/tty}"

usage() { echo "usage: local.sh [--dir <path>] [--port <n>] [--yes] [--no-setup] [--no-start]" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || { usage; exit 2; }; DIR="$2"; shift 2 ;;
    --dir=*) DIR="\${1#--dir=}"; shift ;;
    --port) [ $# -ge 2 ] || { usage; exit 2; }; PORT="$2"; shift 2 ;;
    --port=*) PORT="\${1#--port=}"; shift ;;
    -y|--yes) YES=1; shift ;;
    --no-setup) SETUP=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "local.sh: unknown argument '$1'" >&2; usage; exit 2 ;;
  esac
done

CV="\${HOME:?HOME is not set}/.codervibes"
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
major=\${have#v}; major=\${major%%.*}
case "$major" in "" | *[!0-9]*) major=0 ;; esac
if [ "$major" -lt ${node} ]; then
  warn "Node \${have:-is not on this PATH} - CoderVibes needs ${node} or newer."
  warn "Install it from https://nodejs.org, or run: brew install node   (or: nvm install ${node})"
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
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
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
    while kill -0 "$running" 2>/dev/null && [ $n -lt 10 ]; do n=$((n + 1)); sleep 1; done
    rm -f "$PIDFILE"
    note "Stopped it."
  elif curl -s -o /dev/null -m 2 "$URL/" 2>/dev/null; then
    # Somebody else's. A port is shared, and a script that frees one by
    # killing what holds it is a script that killed somebody's work.
    warn "Something is already listening on $PORT, and it is not one this script started."
    case "$(uname -s 2>/dev/null || echo unknown)" in
      Darwin) warn "See what it is:  lsof -i :$PORT" ;;
      *) warn "See what it is:  ss -ltnp \\"sport = :$PORT\\"" ;;
    esac
    warn "Stop it yourself if it is yours to stop, or run this line again with --port <n>."
    exit 1
  else
    ask "Start CoderVibes on $URL?"
  fi
  PORT="$PORT" nohup node "$DIR/server/local.js" > "$LOG" 2>&1 </dev/null &
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
elif grep -qs "CODERVIBES_ORIGIN=\\"$URL\\"" "$CV/env" && grep -qs '.codervibes/report' "$HOME/.claude/settings.json"; then
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
  stop        kill \\$(cat $PIDFILE)
  start again PORT=$PORT node $DIR/server/local.js   (or run this line again: it updates, then restarts)
  records     $CV/data  (back that up; nothing else will)
  log         $LOG
EOF
fi
`;
}
