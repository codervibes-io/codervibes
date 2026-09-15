// One script that makes whatever coding agent is on a machine report here.
//
// The Executors page used to hand somebody a settings.json to merge into
// ~/.claude by hand, a heredoc for an e2b sandbox, an OTLP header for
// "anything else", and a LiteLLM block - five things to read, one of which
// applied to them. What a person wants is one line: run this, and your next
// session shows up. So this is `curl -fsSL {origin}/setup.sh | sh -s --
// <token>`, and the same line is what a sandbox platform runs before the
// agent starts - e2b's `commands.run`, Niteshift's `niteshift-setup.sh`,
// Cursor's environment install, Codex cloud's setup script - because none
// of them offer a hook that fires on every sandbox for free, and all of
// them offer "run a command first".
//
// **It configures every harness it finds, natively.** Claude Code, Codex
// and Gemini CLI each have an OpenTelemetry export of their own and a hooks
// file of their own, so each is told in its own words: an `env` block and
// hooks in ~/.claude/settings.json, an `[otel]` table and ~/.codex/hooks.json,
// a `telemetry` block and hooks in ~/.gemini/settings.json. Anything else
// gets the standard OTEL_EXPORTER_OTLP_* variables in ~/.codervibes/env,
// which every OpenTelemetry SDK reads - the generic path is the standard
// one, not a wrapper of ours. A harness that is not installed yet is
// configured anyway: the files are cheap, and a `codex` installed tomorrow
// reports without a second setup.
//
// **And it gives each of them this app's tools.** Reporting is one
// direction; the other is the agent reaching back - the repo's chat and
// tasks, and what its owner connected: Linear, GitHub, e2b, whatever is on
// the Connectors page. That is the MCP endpoint at {origin}/mcp, and the
// same token opens it (mcp.js `reachableBy`: on the setup token the agent
// is the person, in the person's repos). So the script writes an MCP
// server named `codervibes` wherever each harness keeps its own -
// `mcpServers` in ~/.claude.json for Claude Code, an `[mcp_servers.codervibes]`
// table for Codex, `mcpServers` in ~/.gemini/settings.json for Gemini CLI,
// ~/.cursor/mcp.json where Cursor is - and ~/.codervibes/mcp.json in the
// `mcpServers` shape most other clients read, with CODERVIBES_MCP_URL in
// the env beside it. Without this a person who ran the line had a Claude
// Code that was seen here and could see nothing here, and the way to the
// connectors was a second dialog and a second token.
//
// **One hook script for all of them.** The three harnesses' hooks agree on
// the shape that matters - JSON on stdin with a `session_id`, a tool's
// name and input - so ~/.codervibes/report is one POSIX sh file that every
// hook calls with the event's name, and the token lives in ~/.codervibes/env
// (mode 600) rather than in three config files. It does not wait on the
// network - a harness runs a hook inside the tool call, so a hook that
// posted charged every tool call the round trip and, when this app was
// reachable but not answering, its whole timeout twice a call - it writes
// the event to ~/.codervibes/spool and a shipper it starts in the
// background posts what the spool holds, in batches, deleting what was
// taken; an app that is down costs a hook nothing and the events wait on
// disk for the next one. It sends the event whole:
// the hook is the one place that has the prompt, the tool's input and
// response, and (at the end of a turn) the transcript, and the export has
// none of them - a timeline of tool names and durations said nothing worth
// opening. The server reads what it keeps (telemetry-ingest.js `noteHook`)
// and shows the words to the session's owner and the people on its repo,
// the shape to everyone else - the rule a resident's transcript already
// has. On top of the event: which repository and machine at the start,
// and the transcript's last lines at a stop, since only the machine has
// the file.
//
// **It works out where it is, and says so.** Nobody should have to tell it
// they are in a sandbox. The platforms leave marks on their machines (e2b
// sets E2B_SANDBOX_ID, Niteshift NITESHIFT_LIFECYCLE_*, and so on -
// machine-source.js has the list), and the script sends the marks it
// found, with its name, its OS and which harnesses are here, to
// `/api/harness/setup`. The server turns the marks into a platform - and
// where they say nothing, asks e2b whether the name is one of its
// sandboxes - and answers with the word, which the script keeps for the
// hooks. So the machine is on the Executors page from the moment setup
// finishes, in the right place, before it has run anything.
//
// **And that is all it does.** It connects the machine to this app: the
// reporting, the tools, the machine's row. It does not decide which model
// a harness calls or where the call goes. It used to - when the
// installation had a LiteLLM proxy, the line asked for a key on it and
// rewrote Claude Code's, Codex's and OpenCode's model settings to route
// through it, unasked - and a person who ran "the line that connects me to
// CoderVibes" found every model call from every harness on their machine
// going somewhere they had not chosen, on somebody else's keys. Where a
// person's model traffic goes is theirs to set, in their harness, on
// purpose; the setup line has no opinion about it and no flag for it.
// test/setup-script.test.js holds that as a rule over the script's text.
//
// **The script itself holds no secret.** The token is an argument (or
// CODERVIBES_TOKEN in the environment), so /setup.sh is public, cacheable,
// and the same for everybody on an installation; the one thing baked in is
// the origin, so a script downloaded from an installation points at it.
//
// **Two things about the installation change it, and nothing else does.**
// A CoderVibes on somebody's own laptop has nobody to authenticate - it
// answers on loopback and there is one person (edition.js) - and it has no
// connectors to hand an agent, so both the token and the MCP server are
// things the line would carry for no reason. A token in a line that
// authenticates nothing is worse than noise: it is a step a person has to
// do, and a credential they will think protects something. So `token:
// "none"` drops every place the token appears - the argument, the check,
// the env file, the export headers, each harness's own header - and `mcp:
// false` drops every MCP server block. The script is otherwise the same
// script, built from the same pieces, because the one way these stay in
// step is that there is only one of them: a second template for the local
// edition would be a second script to keep right, and it would be wrong
// within a month. Defaults are what the hosted product has always sent,
// byte for byte.
import { MARKERS } from "./machine-source.js";

/**
 * The one line a person runs. With no token - a local installation, which
 * has nobody to be - it is the line without one, rather than the line with
 * an empty argument where the token goes.
 */
export const setupCommand = ({ origin, token = null }) =>
  token ? `curl -fsSL ${origin}/setup.sh | sh -s -- ${token}` : `curl -fsSL ${origin}/setup.sh | sh`;

/**
 * The script, for `GET /setup.sh`. Plain POSIX sh: it runs in an Ubuntu
 * sandbox with no bash, on a Mac with zsh, and inside a Dockerfile RUN.
 * Node or python3 is used to merge JSON when present, because Claude Code
 * and Gemini CLI keep hooks in a file that may already hold somebody's
 * own; with neither on the machine an absent file is written fresh and a
 * present one is left alone and said so.
 *
 * @param {{origin: string, token?: "required"|"none", mcp?: boolean}} options
 *   `token: "none"` for an installation that authenticates nobody, and
 *   `mcp: false` for one with no tools to offer. Both default to what the
 *   hosted product sends.
 */
export function setupScript({ origin, token = "required", mcp = true }) {
  const o = String(origin).replace(/\/+$/, "");
  const tokenless = token === "none";
  // A line the script only carries when there is a token (or an MCP server)
  // to carry it for. Written as whole lines including their newline, so
  // that dropping one leaves the lines around it exactly as they were.
  const withToken = (line) => (tokenless ? "" : `${line}\n`);
  const withMcp = (line) => (mcp ? `${line}\n` : "");
  // The Authorization header as each of curl, a JSON file and a TOML table
  // spells it - empty where there is nothing to authorise with.
  const curlAuth = tokenless ? "" : ` -H "Authorization: Bearer $TOKEN"`;
  // The marks the script looks for, in the order the server ranks them.
  const markers = Object.keys(MARKERS).filter((name) => name !== "CODERVIBES_CONTAINER");
  return `#!/bin/sh
# CoderVibes setup: makes the coding agents on this machine report to ${o}.
#
#   ${tokenless ? `curl -fsSL ${o}/setup.sh | sh` : `curl -fsSL ${o}/setup.sh | sh -s -- <your token>`}
#
# Configures Claude Code (~/.claude/settings.json), Codex (~/.codex/config.toml,
# ~/.codex/hooks.json) and Gemini CLI (~/.gemini/settings.json) to export their
# OpenTelemetry here and to report each session as it happens - which
# repository and machine, what was asked, each tool call and what it came to,
# what the agent answered - so the session reads on ${o} the way it read in
# the terminal. Anything else picks the standard OTEL_EXPORTER_OTLP_* variables
${withMcp(`# up from ~/.codervibes/env. Gives each of them ${o}'s tools too - the repo's
# chat and tasks and the services you connected - as an MCP server named
# codervibes (~/.claude.json, ~/.codex/config.toml, ~/.gemini/settings.json,
# and ~/.codervibes/mcp.json for anything else)${tokenless ? "" : ", on the same token"}. Works out`)}${mcp ? "" : `# up from ~/.codervibes/env. This CoderVibes has no services connected to
# hand an agent, so it configures no MCP server in any of them. Works out
`}# whether it is on a laptop or in a sandbox, and tells ${o} which. Safe to run
# again: it replaces what it wrote and nothing else. It does not touch which
# model a harness calls or where: that is yours to set, in the harness.
#
# Set CODERVIBES_MACHINE to say what this machine is called there; without one
# it is called by its sandbox id, or its hostname. Worth setting on anything
# whose id is new every time it is built.
set -eu

ORIGIN="${o}"
${withMcp(`MCP_URL="${o}/mcp"`)}${withToken(`TOKEN="\${CODERVIBES_TOKEN:-}"`)}
usage() {
  echo "usage: ${tokenless ? "setup.sh                   (this CoderVibes needs no token)" : "setup.sh <token>    (the token is on the Executors page)"}" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
${withToken(`    --token) [ $# -ge 2 ] || { usage; exit 2; }; TOKEN="$2"; shift 2 ;;
    --token=*) TOKEN="\${1#--token=}"; shift ;;`)}    -h|--help) usage; exit 0 ;;
    -*) echo "setup.sh: unknown argument '$1'" >&2; usage; exit 2 ;;
${tokenless ? `    # This CoderVibes authenticates nobody, so a token would be a word
    # with nothing to mean. Refused rather than ignored: somebody passing
    # one has the wrong line, and silence would let them believe otherwise.
    *) echo "setup.sh: takes no arguments - this CoderVibes needs no token." >&2; usage; exit 2 ;;
` : `    # A bare word is the token, whatever it looks like; what it must look
    # like is said below, in a sentence about the token rather than one
    # about an argument.
    *) TOKEN="$1"; shift ;;
`}  esac
done
${withToken(`
if [ -z "$TOKEN" ]; then
  echo "setup.sh: no token. Pass the one from the Executors page, or set CODERVIBES_TOKEN." >&2
  exit 2
fi
case "$TOKEN" in
  cvh1.*) ;;
  *) echo "setup.sh: '$TOKEN' is not a CoderVibes token - they start with cvh1." >&2; exit 2 ;;
esac`)}
HOME_DIR="\${HOME:?HOME is not set}"
CV="$HOME_DIR/.codervibes"
mkdir -p "$CV"
chmod 700 "$CV"

# ------------------------------------------------------- where this is

# The marks the platforms leave on their machines. Sent to the server,
# which knows what each means and can ask e2b about a name that carries
# none; kept here only as a first guess for the hooks, until it answers.
MARKERS=""
for name in ${markers.join(" ")}; do
  eval "value=\\\${$name:-}"
  [ -n "$value" ] && MARKERS="$MARKERS\${MARKERS:+,}$name"
done
if [ -z "$MARKERS" ] && { [ -f /.dockerenv ] || grep -qs 'docker\\|containerd\\|kubepods' /proc/1/cgroup 2>/dev/null; }; then
  MARKERS="CODERVIBES_CONTAINER"
fi
# What this machine is called here. A name given outright wins, because the
# id a sandbox is born with is not a name: a platform that rebuilds its image
# on a schedule - Niteshift rebuilds daily - hands back a different id every
# time, and the Executors page fills with a row per rebuild, none of them
# saying which is which. A person who sets CODERVIBES_MACHINE has said what
# the thing is; that outlives the sandbox. Failing that, the sandbox id, and
# failing that the hostname.
MACHINE="\${CODERVIBES_MACHINE:-\${E2B_SANDBOX_ID:-$(hostname 2>/dev/null || echo unknown)}}"
OS="$(uname -s 2>/dev/null || echo unknown) $(uname -m 2>/dev/null || true)"
PLATFORM=""

# --------------------------------------------- what every harness shares

${tokenless ? `# The standard OpenTelemetry variables, for the hook below and for any tool
# that reads OTEL_EXPORTER_OTLP_* from its environment. No token in it, and
# so no header on the export: this CoderVibes authenticates nobody. Written
# again at the end, once the server has said where this is.` : `# The token and the standard OpenTelemetry variables, for the hook below and
# for any tool that reads OTEL_EXPORTER_OTLP_* from its environment. Written
# again at the end, once the server has said where this is.`}
write_env() {
  umask 077
  cat > "$CV/env" <<EOF
# Written by ${o}/setup.sh. Sourced by ~/.codervibes/report and by the shell.
export CODERVIBES_ORIGIN="$ORIGIN"
${withToken(`export CODERVIBES_TOKEN="$TOKEN"`)}export CODERVIBES_PLATFORM="$PLATFORM"
export CODERVIBES_MACHINE="$MACHINE"
${withMcp(`export CODERVIBES_MCP_URL="$MCP_URL"`)}export OTEL_EXPORTER_OTLP_ENDPOINT="$ORIGIN/otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
${withToken(`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $TOKEN"`)}EOF
  umask 022
}
write_env
${withMcp(`
# This app's tools, for any client that reads the common \`mcpServers\`
# shape (Cursor, Windsurf, VS Code, Zed and most others take this block as
# it is). The harnesses below get the same server in their own files.
mcp_block() {
  printf '${tokenless ? `{"mcpServers":{"codervibes":{"type":"http","url":"%s"}}}' "$MCP_URL"` : `{"mcpServers":{"codervibes":{"type":"http","url":"%s","headers":{"Authorization":"Bearer %s"}}}}' "$MCP_URL" "$TOKEN"`}
}
umask 077
mcp_block > "$CV/mcp.json"
umask 022`)}
# The hook. Called as \`report <event>\` with the harness's JSON on stdin,
# and posts that JSON whole as \`input\`, under the event's name and the
# session id read off it. A start adds the checkout and the machine; a stop
# adds the transcript's last assistant lines, which only this machine can
# read. The body goes over stdin, not an argument: a tool's response can be
# bigger than an argument may be.
#
# Nothing here waits on the network. The harness runs a hook inside the
# tool call and waits for it to exit, so a hook that posts is a hook that
# charges every tool call the round trip - and, when ${o} is reachable
# but not answering, the whole timeout, twice a call, for as long as that
# lasts. So the event is written to ~/.codervibes/spool and the script
# exits, and \`ship\` (below), started in the background with nothing of
# the harness's attached, posts what the spool holds. An app that is down
# costs the hook nothing and loses nothing: the events wait on disk, and
# the next hook ships them. The name orders them - the second and the pid,
# which grows between one hook and the next - and \`at\` says when, so a
# backlog shipped later still reads in order and at its own time.
cat > "$CV/report" <<'EOF'
#!/bin/sh
[ "\${CODERVIBES_REPORTING:-1}" = 0 ] && exit 0
. "$HOME/.codervibes/env" 2>/dev/null || exit 0
event="\${1:-}"
input=$(cat 2>/dev/null || true)
session=$(printf %s "$input" | sed -n 's/.*"session_id" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)
[ -n "$session" ] || exit 0
case "$input" in "{"*) ;; *) input="{}" ;; esac
machine="\${CODERVIBES_MACHINE:-\${E2B_SANDBOX_ID:-$(hostname 2>/dev/null)}}"
platform="\${CODERVIBES_PLATFORM:-\${E2B_SANDBOX_ID:+e2b}}"
extra=""
case "$event" in
  start)
    repo=$(git remote get-url origin 2>/dev/null || true)
    branch=$(git branch --show-current 2>/dev/null || true)
    extra=",\\"repo\\":\\"$repo\\",\\"branch\\":\\"$branch\\",\\"machine\\":\\"$machine\\",\\"platform\\":\\"$platform\\"" ;;
  stop)
    path=$(printf %s "$input" | sed -n 's/.*"transcript_path" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)
    lines=""
    if [ -n "$path" ] && [ -r "$path" ]; then
      lines=$(grep -F '"type":"assistant"' "$path" 2>/dev/null | tail -n 5 | tr '\\n' ',')
    fi
    extra=",\\"transcript\\":[\${lines%,}]" ;;
  end|prompt|tool|done|file|subagent) ;;
  *) exit 0 ;;
esac
spool="$HOME/.codervibes/spool"
umask 077
mkdir -p "$spool"
now=$(date +%s)
name=$(printf '%010d-%08d' "$now" "$$")
printf %s "{\\"event\\":\\"$event\\",\\"session\\":\\"$session\\",\\"at\\":$now$extra,\\"input\\":$input}" > "$spool/$name.tmp" && mv "$spool/$name.tmp" "$spool/$name.json"
# A spool nobody has shipped for weeks is bounded: over the cap, the oldest goes.
set -- "$spool"/*.json
[ $# -gt 5000 ] && rm -f "$1"
"$HOME/.codervibes/ship" </dev/null >/dev/null 2>&1 &
exit 0
EOF
chmod 755 "$CV/report"

# The shipper. Posts the spool oldest first, twenty events a request, and
# deletes what ${o} took. It stops at the first request that did not get
# through - the network, or a 5xx - and leaves the rest for the next hook;
# a 4xx is an answer, not an outage, and the events it refused are dropped
# rather than offered again forever. One at a time: a second shipper
# started while one runs exits at once, and a lock whose holder is gone
# (a machine that went down mid-batch) is taken over. Nothing of the
# harness's is attached to it, so the harness does not wait for it.
cat > "$CV/ship" <<'EOF'
#!/bin/sh
. "$HOME/.codervibes/env" 2>/dev/null || exit 0
spool="$HOME/.codervibes/spool"
lock="$spool/.lock"
if ! mkdir "$lock" 2>/dev/null; then
  holder=$(cat "$lock/pid" 2>/dev/null)
  [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null && exit 0
  rm -rf "$lock" && mkdir "$lock" 2>/dev/null || exit 0
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
while :; do
  batch=""; n=0
  for f in "$spool"/*.json; do
    [ -f "$f" ] || break
    batch="$batch\${batch:+ }$f"; n=$((n + 1))
    [ $n -ge 20 ] && break
  done
  [ $n -gt 0 ] || exit 0
  code=$({ printf '{"events":['; sep=""; for f in $batch; do printf %s "$sep"; cat "$f"; sep=","; done; printf ']}'; } |
    curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 -m 20 -X POST "$CODERVIBES_ORIGIN/api/harness/session" \\
     ${tokenless ? "" : ` -H "Authorization: Bearer $CODERVIBES_TOKEN"`} -H "Content-Type: application/json" -d @-) || exit 0
  case "$code" in 2*|4*) rm -f $batch ;; *) exit 0 ;; esac
done
EOF
chmod 755 "$CV/ship"

# The shell reads the variables too, so a harness with no config file of its
# own - or a tool that only knows the standard variables - still exports.
for rc in "$HOME_DIR/.profile" "$HOME_DIR/.bashrc" "$HOME_DIR/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q '\\.codervibes/env' "$rc" 2>/dev/null && continue
  printf '\\n# CoderVibes: the coding agents here report to %s\\n[ -f "$HOME/.codervibes/env" ] && . "$HOME/.codervibes/env"\\n' "$ORIGIN" >> "$rc"
done

# JSON merging, for the two harnesses whose settings file may already hold
# somebody's own hooks. \`merge_json <file> <ours>\` writes ours over the file's
# top-level keys (hooks are replaced per event, ours for ours - an entry that
# calls ~/.codervibes/report is ours, anything else is kept). Returns 1 when
# there is no interpreter to do it with.
merge_json() {
  file="$1"; ours="$2"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs"); const [file, ours] = process.argv.slice(1);
      let have = {}; try { have = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const add = JSON.parse(ours);
      const mine = (entry) => JSON.stringify(entry).includes(".codervibes/report");
      for (const [key, value] of Object.entries(add)) {
        if (key === "hooks" && have.hooks && typeof have.hooks === "object") {
          for (const [event, entries] of Object.entries(value)) {
            const kept = Array.isArray(have.hooks[event]) ? have.hooks[event].filter((e) => !mine(e)) : [];
            have.hooks[event] = [...kept, ...entries];
          }
        } else if (value && typeof value === "object" && !Array.isArray(value) && have[key] && typeof have[key] === "object" && !Array.isArray(have[key])) {
          have[key] = { ...have[key], ...value };
        } else have[key] = value;
      }
      fs.writeFileSync(file, JSON.stringify(have, null, 2) + "\\n");
    ' "$file" "$ours"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$file" "$ours" <<'PY'
import json, sys
file, ours = sys.argv[1], sys.argv[2]
try:
    with open(file) as f: have = json.load(f)
except Exception: have = {}
add = json.loads(ours)
mine = lambda e: ".codervibes/report" in json.dumps(e)
for key, value in add.items():
    if key == "hooks" and isinstance(have.get("hooks"), dict):
        for event, entries in value.items():
            kept = [e for e in have["hooks"].get(event, []) if not mine(e)] if isinstance(have["hooks"].get(event), list) else []
            have["hooks"][event] = kept + entries
    elif isinstance(value, dict) and isinstance(have.get(key), dict):
        have[key] = {**have[key], **value}
    else:
        have[key] = value
with open(file, "w") as f: json.dump(have, f, indent=2); f.write("\\n")
PY
  else
    return 1
  fi
}

# Writes \`ours\` as the file when it is absent, merges when it exists and an
# interpreter is here, and otherwise leaves it and says what to add.
settle_json() {
  file="$1"; ours="$2"; who="$3"
  mkdir -p "$(dirname "$file")"
  if [ ! -s "$file" ]; then
    printf '%s\\n' "$ours" > "$file"
    echo "  $who: wrote $file"
  elif merge_json "$file" "$ours"; then
    echo "  $who: merged into $file"
  else
    echo "  $who: $file exists and there is no node or python3 to merge with. Add this to it by hand:" >&2
    printf '%s\\n' "$ours" >&2
  fi
}

# One hook entry, in the shape all three harnesses read, for every tool
# (no matcher). $HOME is expanded by the shell the harness runs the hook
# in, not here.
hook() { printf '{"hooks":[{"type":"command","command":"$HOME/.codervibes/report %s","timeout":5}]}' "$1"; }

echo "Connecting $MACHINE to $ORIGIN"

# ------------------------------------------------------------ Claude Code
# Its export is switched on by environment variables it reads from its own
# settings file, so nothing has to be exported by the shell; the export is
# asked for the prompt too. The hooks say what the export cannot: the
# checkout, each tool's input and what came of it, what the agent said -
# and what each subagent said back to it (SubagentStop carries the
# subagent's last message; its tool calls fire the same PreToolUse and
# PostToolUse hooks, marked with agent_id and agent_type). The env block
# is the export and nothing else: no address for its model calls, no model
# names - where Claude Code sends them is left exactly as the person has it.
settle_json "$HOME_DIR/.claude/settings.json" "$(cat <<EOF
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "$ORIGIN/otlp",
${withToken(`    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer $TOKEN",`)}    "OTEL_LOGS_EXPORT_INTERVAL": "5000",
    "OTEL_LOG_USER_PROMPTS": "1"
  },
  "hooks": {
    "SessionStart": [$(hook start)],
    "SessionEnd": [$(hook end)],
    "UserPromptSubmit": [$(hook prompt)],
    "PreToolUse": [$(hook tool)],
    "PostToolUse": [$(hook done)],
    "Stop": [$(hook stop)],
    "SubagentStop": [$(hook subagent)]
  }
}
EOF
)" "Claude Code"
${withMcp(`# Its MCP servers live in ~/.claude.json, not in settings.json - the file
# \`claude mcp add --scope user\` writes to - so the server goes there, in
# the shape that command writes, beside whatever else the file holds.
settle_json "$HOME_DIR/.claude.json" "$(mcp_block)" "Claude Code MCP"`)}
# ------------------------------------------------------------------ Codex
# An [otel] table in config.toml; the endpoint is the whole logs path, since
# its exporter does not append one. Prompts are exported, like Claude Code's.
# The table is added once and left alone afterwards, and one somebody wrote
# themselves is theirs.
CODEX="$HOME_DIR/.codex/config.toml"
mkdir -p "$HOME_DIR/.codex"
if [ -f "$CODEX" ] && grep -q '^\\[otel\\]' "$CODEX" 2>/dev/null; then
  if grep -q "$ORIGIN/otlp/v1/logs" "$CODEX"; then
    echo "  Codex: $CODEX already has this app's [otel] table"
  else
    echo "  Codex: $CODEX has an [otel] table of its own; not touched. To report here, point it at $ORIGIN/otlp/v1/logs${tokenless ? "" : " with the header in ~/.codervibes/env"}." >&2
  fi
else
  cat >> "$CODEX" <<EOF

# CoderVibes: send this Codex's telemetry to $ORIGIN (codervibes), prompts included.
[otel]
log_user_prompt = true
exporter = { otlp-http = { endpoint = "$ORIGIN/otlp/v1/logs", protocol = "json"${tokenless ? "" : `, headers = { Authorization = "Bearer $TOKEN" }`} } }
EOF
  echo "  Codex: added [otel] to $CODEX"
fi
${withMcp(`# Its MCP servers are tables in the same file. Ours is replaced on every
# run - the token in it may have been rotated - by cutting the table from
# its header to the next one, and nothing else in the file is touched.
if [ -f "$CODEX" ] && grep -q '^\\[mcp_servers\\.codervibes\\]' "$CODEX" 2>/dev/null; then
  awk 'BEGIN { skip = 0 } /^\\[/ { skip = ($0 == "[mcp_servers.codervibes]") } !skip { print }' "$CODEX" > "$CODEX.cv-tmp" && mv "$CODEX.cv-tmp" "$CODEX"
fi
cat >> "$CODEX" <<EOF

# CoderVibes: this app's tools - the repo's chat and tasks, the services you connected.
[mcp_servers.codervibes]
url = "$MCP_URL"
${tokenless ? "" : `http_headers = { Authorization = "Bearer $TOKEN" }\n`}EOF
echo "  Codex: MCP server codervibes in $CODEX"`)}settle_json "$HOME_DIR/.codex/hooks.json" "$(cat <<EOF
{
  "hooks": {
    "SessionStart": [$(hook start)],
    "SessionEnd": [$(hook end)]
  }
}
EOF
)" "Codex hooks"

# ------------------------------------------------------------- Gemini CLI
# Its telemetry block names the endpoint, which it appends /v1/logs to
${tokenless ? `# itself, and the protocol. There is no header to give it: this CoderVibes
# authenticates nobody, which is what makes the export one variable shorter.` : `# itself, and the protocol; the header comes from OTEL_EXPORTER_OTLP_HEADERS
# in the environment, which is why the shell sources ~/.codervibes/env.`}
settle_json "$HOME_DIR/.gemini/settings.json" "$(cat <<EOF
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "otlpEndpoint": "$ORIGIN/otlp",
    "otlpProtocol": "http",
    "logPrompts": true
  },
  "hooks": {
    "SessionStart": [$(hook start)],
    "SessionEnd": [$(hook end)],
    "BeforeTool": [$(hook tool)],
    "AfterTool": [$(hook done)]
${mcp ? `  },
  "mcpServers": {
    "codervibes": { "httpUrl": "$MCP_URL"${tokenless ? "" : `, "headers": { "Authorization": "Bearer $TOKEN" }`} }
  }` : `  }`}
}
EOF
)" "Gemini CLI"
${withMcp(`
# --------------------------------------------------------------- OpenCode
# No telemetry export to point here; it reads the \`mcp\` block of its own
# config for the tools. Its providers and its model are left as they are.
settle_json "$HOME_DIR/.config/opencode/opencode.json" "$(printf '${tokenless ? `{"mcp":{"codervibes":{"type":"remote","url":"%s"}}}' "$MCP_URL"` : `{"mcp":{"codervibes":{"type":"remote","url":"%s","headers":{"Authorization":"Bearer %s"}}}}' "$MCP_URL" "$TOKEN"`})" "OpenCode"

# ------------------------------------------------------------------ Cursor
# No telemetry export of its own to point here, but it reads the common
# mcpServers shape from ~/.cursor/mcp.json - written only where Cursor is,
# since a ~/.cursor on a machine without it is litter.
if [ -d "$HOME_DIR/.cursor" ]; then
  settle_json "$HOME_DIR/.cursor/mcp.json" "$(mcp_block)" "Cursor MCP"
fi`)}
# ----------------------------------------------------- tell the server

# Which harnesses are actually here - the files above are written either
# way - so the machine's row can say what runs on it.
HERE=""
for tool in claude codex gemini opencode; do
  command -v "$tool" >/dev/null 2>&1 && HERE="$HERE\${HERE:+,}\\"$tool\\""
done
# The report: name, OS, marks, harnesses. The answer says where this is,
# which is kept for the hooks - a Niteshift environment marks its setup
# phase and nothing after it, so the hook could not work it out later.
answer=$(curl -s -m 5 -X POST "$ORIGIN/api/harness/setup" \\
 ${tokenless ? "" : ` -H "Authorization: Bearer $TOKEN"`} -H "Content-Type: application/json" \\
  -d "{\\"machine\\":\\"$MACHINE\\",\\"os\\":\\"$OS\\",\\"markers\\":\\"$MARKERS\\",\\"harnesses\\":[$HERE]}" 2>/dev/null || true)
PLATFORM=$(printf %s "$answer" | sed -n 's/.*"platform" *: *"\\([^"]*\\)".*/\\1/p' | head -n 1)
case "$PLATFORM" in
  ""|laptop) PLATFORM="" ;;
esac
write_env

if [ -n "$answer" ]; then
  echo "Done. $MACHINE is on $ORIGIN/executors\${PLATFORM:+ as an $PLATFORM machine}; start a session in any of them and it appears there${mcp ? ", with $ORIGIN's tools as the MCP server 'codervibes'" : ""}."
else
  echo "Done, but $ORIGIN could not be reached to say so - check ${tokenless ? "that it is running" : "the token and the network"}. Sessions will still try to report."
fi
`;
}
