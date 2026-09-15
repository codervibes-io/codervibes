// The LiteLLM setup script: one line that stands a proxy up, wired to
// report here, wherever the person runs it.
//
// LiteLLM is a proxy an engineer runs themselves - open source, one
// container, a Postgres behind it for the keys and spend it keeps. The
// LiteLLM page under Connectors used to say only how a proxy that already
// exists reports here (three variables), and left standing one up to the
// reader. What a person wants is what the executor setup gives them: one
// line, run where the proxy should live, and it is running and reporting.
// So this is `curl -fsSL {origin}/litellm.sh | sh -s -- <token> [where]`.
//
// **Where** is one of four places, each what its platform has:
//
//   --docker      (default) the machine this runs on, with docker compose:
//                 the proxy and a Postgres, on port 4000, restarted with
//                 the machine. A laptop, a VM, anything with Docker.
//   --kubernetes  the cluster kubectl points at: the manifests under
//                 deploy/litellm, applied to a namespace, reachable inside
//                 the cluster as litellm.<namespace>.svc:4000.
//   --fly         a new Fly app, with a Fly Postgres attached, reachable on
//                 the public internet at <app>.fly.dev. Needs flyctl,
//                 signed in.
//   --pip         no Docker at all: `pip install litellm[proxy]` and the
//                 proxy as a process, on the master key alone (no database,
//                 so no per-executor keys). What a sandbox gets: e2b's base
//                 machine has python and no Docker.
//
// **What is the same everywhere:** the files. deploy/litellm holds the
// config.yaml, the compose file and the Kubernetes manifests, read here on
// the first ask and written by the script as they are - one source, so a person
// who reads deploy/litellm sees what the line will do, and a person who
// ran the line finds the same files under ~/.codervibes/litellm to change
// by hand. The script fills in what it can only know when it runs: the
// provider keys from the environment it runs in (never asked for, never
// written anywhere but the proxy's own .env), a master key and a salt key
// it generates, and this installation's address and the token it was
// given, so the proxy reports every call it routes here from its first.
//
// **What it prints at the end** is what the person needs next: the
// proxy's address, the master key (once), and the three installation
// secrets that make this installation send its own calls through the
// proxy and mint a key per executor - which the script cannot set, since
// the token it holds reports and does not administer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY = path.join(here, "..", "deploy", "litellm");
const read = (name) => fs.readFileSync(path.join(DEPLOY, name), "utf8");

/**
 * The files under deploy/litellm, as the script writes them. Read once, on
 * the first ask rather than at import.
 *
 * Lazily, because this module has two kinds of caller and only one of them
 * wants the files: `/litellm.sh` writes them out, and harnesses.js imports
 * this module for `litellmCommand` - one line of text with no file behind it.
 * Reading a directory at import time made importing this module a claim on
 * the checkout's shape, and the local edition (server/local.js, published as
 * its own repository by scripts/cut-local.mjs) carries no deploy/ at all: it
 * could not boot, and the reason was five frames deep in a page it had not
 * been asked for yet.
 */
let files = null;
export const FILES = () =>
  (files ??= {
    config: read("config.yaml"),
    compose: read("docker-compose.yml"),
    k8s: {
      namespace: read(path.join("k8s", "namespace.yaml")),
      postgres: read(path.join("k8s", "postgres.yaml")),
      litellm: read(path.join("k8s", "litellm.yaml")),
    },
  });

/** The image the compose file and the manifests pin, for the Fly path and the words. */
export const IMAGE = () =>
  (FILES().compose.match(/image:\s*(\S+litellm[^\s]*)/) ?? [])[1] ?? "docker.litellm.ai/berriai/litellm-database:latest";

/** The one line a person runs, for the page. */
export const litellmCommand = ({ origin, token, where = null }) =>
  `curl -fsSL ${origin}/litellm.sh | sh -s -- ${token}${where ? ` --${where}` : ""}`;

/** A file's text as a quoted heredoc the script can write it from: nothing in it is expanded. */
const heredoc = (target, text) => `cat > ${target} <<'CV_FILE'\n${text.replace(/\n$/, "")}\nCV_FILE`;

/**
 * The script, for `GET /litellm.sh`. Plain POSIX sh, like setup.sh: it runs
 * on a Mac, in an Ubuntu sandbox with no bash, on a VM somebody just made.
 */
export function litellmSetupScript({ origin }) {
  const o = String(origin).replace(/\/+$/, "");
  return `#!/bin/sh
# CoderVibes: stand up a LiteLLM proxy that reports to ${o}.
#
#   curl -fsSL ${o}/litellm.sh | sh -s -- <your token> [--docker|--kubernetes|--fly|--pip] [options]
#
# Writes the proxy's config, its compose file or manifests, and a .env with
# the provider keys found in this shell's environment (ANTHROPIC_API_KEY,
# OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY), a generated master
# key, and the three variables that make the proxy report every call to
# ${o}; then starts it where you said. Files go under
# ~/.codervibes/litellm (or --dir), to change by hand and start again.
#
# Options:
#   --docker              this machine, with docker compose (default)
#   --kubernetes          the cluster kubectl points at (--namespace, default litellm)
#   --fly                 a new Fly app with a Postgres attached (--app, --region)
#   --pip                 no Docker: pip install litellm[proxy] and run it as a process
#   --port <n>            the port the proxy listens on (docker, pip; default 4000)
#   --dir <path>          where the files go
#   --print               write the files and start nothing
#   --no-report           do not point the proxy's OpenTelemetry at ${o}
set -eu

ORIGIN="${o}"
TOKEN="\${CODERVIBES_TOKEN:-}"
WHERE="docker"
PORT="4000"
DIR="\${HOME:-/tmp}/.codervibes/litellm"
NAMESPACE="litellm"
APP=""
REGION=""
PRINT_ONLY=0
REPORT=1

usage() {
  echo "usage: litellm.sh <token> [--docker|--kubernetes|--fly|--pip] [--port n] [--dir path] [--namespace ns] [--app name] [--region r] [--print] [--no-report]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --docker|--compose) WHERE="docker"; shift ;;
    --kubernetes|--k8s) WHERE="kubernetes"; shift ;;
    --fly) WHERE="fly"; shift ;;
    --pip|--local) WHERE="pip"; shift ;;
    --port) [ $# -ge 2 ] || { usage; exit 2; }; PORT="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || { usage; exit 2; }; DIR="$2"; shift 2 ;;
    --namespace) [ $# -ge 2 ] || { usage; exit 2; }; NAMESPACE="$2"; shift 2 ;;
    --app) [ $# -ge 2 ] || { usage; exit 2; }; APP="$2"; shift 2 ;;
    --region) [ $# -ge 2 ] || { usage; exit 2; }; REGION="$2"; shift 2 ;;
    --print) PRINT_ONLY=1; shift ;;
    --no-report) REPORT=0; shift ;;
    --token) [ $# -ge 2 ] || { usage; exit 2; }; TOKEN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "litellm.sh: unknown argument '$1'" >&2; usage; exit 2 ;;
    *) TOKEN="$1"; shift ;;
  esac
done

if [ "$REPORT" = 1 ]; then
  if [ -z "$TOKEN" ]; then
    echo "litellm.sh: no token. Pass the one from the LiteLLM page under Connectors, or --no-report to start a proxy that does not report to $ORIGIN." >&2
    exit 2
  fi
  case "$TOKEN" in
    cvh1.*) ;;
    *) echo "litellm.sh: '$TOKEN' is not a CoderVibes token - they start with cvh1." >&2; exit 2 ;;
  esac
fi
case "$PORT" in
  ''|*[!0-9]*) echo "litellm.sh: --port takes a number" >&2; exit 2 ;;
esac

# ------------------------------------------------------------- the keys

# A random key, the way the platform can make one. openssl is on nearly
# everything; /dev/urandom is on the rest.
random_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n'
  fi
}

MASTER_KEY="\${LITELLM_MASTER_KEY:-}"
[ -n "$MASTER_KEY" ] || MASTER_KEY="sk-$(random_key)"
SALT_KEY="\${LITELLM_SALT_KEY:-}"
[ -n "$SALT_KEY" ] || SALT_KEY="sk-$(random_key)"
DB_PASSWORD="\${POSTGRES_PASSWORD:-}"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(random_key)"

# The provider keys, from this shell. Said by name, never by value.
FOUND=""
MISSING=""
for name in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
  eval "value=\\\${$name:-}"
  if [ -n "$value" ]; then FOUND="$FOUND\${FOUND:+, }$name"; else MISSING="$MISSING\${MISSING:+, }$name"; fi
done

# ------------------------------------------------------------ the files

mkdir -p "$DIR"
chmod 700 "$DIR"
cd "$DIR"

${heredoc("config.yaml", FILES().config)}

${heredoc("docker-compose.yml", FILES().compose)}

mkdir -p k8s
${heredoc("k8s/namespace.yaml", FILES().k8s.namespace)}
${heredoc("k8s/postgres.yaml", FILES().k8s.postgres)}
${heredoc("k8s/litellm.yaml", FILES().k8s.litellm)}
cat > kustomization.yaml <<CV_FILE
# Written by $ORIGIN/litellm.sh; the same as deploy/litellm/kustomization.yaml
# in the CoderVibes repository, for this namespace.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: $NAMESPACE
resources:
  - k8s/namespace.yaml
  - k8s/postgres.yaml
  - k8s/litellm.yaml
configMapGenerator:
  - name: litellm-config
    files:
      - config.yaml
secretGenerator:
  - name: litellm-env
    envs:
      - .env
generatorOptions:
  disableNameSuffixHash: true
CV_FILE
# The namespace manifest names the namespace too.
sed "s/^  name: litellm$/  name: $NAMESPACE/" k8s/namespace.yaml > k8s/namespace.yaml.tmp && mv k8s/namespace.yaml.tmp k8s/namespace.yaml

# The environment: keys and where to report. Mode 600 - it is every
# credential the proxy holds.
umask 077
{
  echo "# Written by $ORIGIN/litellm.sh. The proxy's environment; docker compose and kustomize both read it."
  echo "LITELLM_MASTER_KEY=$MASTER_KEY"
  echo "LITELLM_SALT_KEY=$SALT_KEY"
  echo "POSTGRES_PASSWORD=$DB_PASSWORD"
  echo "LITELLM_PORT=$PORT"
  for name in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    eval "value=\\\${$name:-}"
    echo "$name=$value"
  done
  if [ "$REPORT" = 1 ]; then
    echo "OTEL_EXPORTER=otlp_http"
    echo "OTEL_ENDPOINT=$ORIGIN/otlp/v1/traces"
    echo "OTEL_HEADERS=Authorization=Bearer $TOKEN"
  fi
} > .env
umask 022

echo "LiteLLM files are in $DIR"
[ -n "$FOUND" ] && echo "  provider keys from this shell: $FOUND"
[ -n "$MISSING" ] && echo "  not set here, so those models will answer with an error until added to $DIR/.env: $MISSING"

if [ "$PRINT_ONLY" = 1 ]; then
  echo "Nothing started (--print). Start it with: cd $DIR && docker compose up -d   (or kubectl apply -k $DIR)"
  exit 0
fi

# ----------------------------------------------------------- the words

# What comes after, the same wherever the proxy is: the address, the key,
# and how this installation is told about it.
# The provider keys the proxy calls with.
#
# config.yaml names a credential per provider rather than an environment
# variable, so that a key can be rotated without restarting the proxy -
# which means something has to put them there the first time. On a proxy
# stood up on its own, that something is this; a CoderVibes installation
# holding the same keys keeps them in step afterwards.
#
# The values come from the .env written above. An empty one is skipped: a
# provider with no credential answers a call with an error, exactly as it
# did with no environment variable set.
seed_credentials() {
  url="$1"
  # Credentials are rows in the proxy's database, which is up a little
  # after the proxy first answers.
  i=0
  while [ "$i" -lt 40 ]; do
    curl -fs -m 3 "$url/health/readiness" 2>/dev/null | grep -q '"db":"connected"' && break
    i=$((i + 1)); sleep 3
  done
  seeded=""
  for pair in anthropic:ANTHROPIC_API_KEY openai:OPENAI_API_KEY gemini:GEMINI_API_KEY openrouter:OPENROUTER_API_KEY moonshot:MOONSHOT_API_KEY; do
    provider=\${pair%%:*}
    var=\${pair#*:}
    value=$(grep "^$var=" "$DIR/.env" 2>/dev/null | cut -d= -f2-)
    [ -n "$value" ] || continue
    if curl -fs -m 10 -X POST "$url/credentials" \
      -H "Authorization: Bearer $MASTER_KEY" -H 'Content-Type: application/json' \
      -d "{\\"credential_name\\":\\"codervibes-$provider\\",\\"credential_info\\":{\\"custom_llm_provider\\":\\"$provider\\",\\"managed_by\\":\\"litellm.sh\\"},\\"credential_values\\":{\\"api_key\\":\\"$value\\"}}" >/dev/null 2>&1; then
      seeded="$seeded\${seeded:+, }$provider"
    else
      echo "litellm.sh: the proxy would not take the $provider key. Set it on the LiteLLM page at $ORIGIN, or at $url/ui." >&2
    fi
  done
  if [ -n "$seeded" ]; then
    echo "Provider keys stored on the proxy, as credentials it reads per call: $seeded"
  else
    echo "No provider keys were set, so the proxy can route nothing yet. Put them in $DIR/.env and run this again, or set them on the LiteLLM page at $ORIGIN." >&2
  fi
}

finish() {
  url="$1"
  fly_app="\${2:-}"
  seed_credentials "$url"
  echo
  echo "LiteLLM is up at $url"
  echo "  master key (shown once; kept in $DIR/.env): $MASTER_KEY"
  echo "  admin UI: $url/ui   (username admin, password the master key)"
  echo "  try it:   curl -s $url/v1/models -H 'Authorization: Bearer $MASTER_KEY'"
  if [ "$REPORT" = 1 ]; then
    echo "  every call it routes is reported to $ORIGIN, on the sessions that made them."
  fi
  echo
  echo "To have $ORIGIN send its agents' calls through it, and mint a key per executor it sets up,"
  echo "add three installation secrets to the app there (installation-secrets.js says how):"
  echo "  LITELLM_BASE_URL=$url/v1"
  echo "  LITELLM_API_KEY=<a key minted at $url/ui, or the master key>"
  echo "  LITELLM_MASTER_KEY=$MASTER_KEY"
  if [ -n "$fly_app" ]; then
    echo
    echo "Or hand this one to $ORIGIN to run, and let the LiteLLM page under Connectors start and stop it."
    echo "Two installation secrets instead of the three above:"
    echo "  LITELLM_MANAGED_APP=$fly_app"
    echo "  LITELLM_MANAGED_MASTER_KEY=$MASTER_KEY"
    echo
    echo "Then stop its machines and leave them stopped - 'fly machines stop -a $fly_app --select', or the"
    echo "switch on that page. A stopped machine keeps its volume and its image and costs nothing, so the"
    echo "proxy sits there deployed until somebody turns it on."
  fi
}

wait_ready() {
  url="$1"; tries="\${2:-60}"
  i=0
  while [ "$i" -lt "$tries" ]; do
    if curl -fs -m 3 "$url/health/liveliness" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 3
  done
  return 1
}

# --------------------------------------------------------------- docker
if [ "$WHERE" = docker ]; then
  command -v docker >/dev/null 2>&1 || { echo "litellm.sh: docker is not installed here. Install Docker, or run with --pip to start the proxy as a process, or --kubernetes / --fly." >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "litellm.sh: 'docker compose' is not available; install the Compose plugin." >&2; exit 1; }
  echo "Starting the proxy and its database with docker compose..."
  docker compose up -d
  if wait_ready "http://127.0.0.1:$PORT" 60; then
    finish "http://127.0.0.1:$PORT"
  else
    echo "litellm.sh: the proxy did not answer on port $PORT within three minutes. 'docker compose logs litellm' in $DIR says why." >&2
    exit 1
  fi
  exit 0
fi

# ------------------------------------------------------------------ pip
if [ "$WHERE" = pip ]; then
  PY=""
  for candidate in python3 python; do command -v "$candidate" >/dev/null 2>&1 && { PY="$candidate"; break; }; done
  [ -n "$PY" ] || { echo "litellm.sh: no python3 here, and --pip needs one. Docker, --kubernetes or --fly are the other ways." >&2; exit 1; }
  if ! command -v litellm >/dev/null 2>&1 && ! "$PY" -m litellm --help >/dev/null 2>&1; then
    echo "Installing litellm[proxy] with pip (a few minutes)..."
    "$PY" -m pip install --quiet --user "litellm[proxy]" 2>/dev/null || "$PY" -m pip install --quiet "litellm[proxy]"
  fi
  LITELLM_BIN="litellm"
  command -v litellm >/dev/null 2>&1 || LITELLM_BIN="$HOME/.local/bin/litellm"
  [ -x "$LITELLM_BIN" ] || LITELLM_BIN="$PY -m litellm"
  # The .env is compose's; the process reads its environment. Everything
  # but DATABASE_URL, which a --pip proxy has none of unless the shell had one.
  set -a
  . ./.env
  set +a
  export STORE_MODEL_IN_DB="\${DATABASE_URL:+True}"
  echo "Starting the proxy as a process (log: $DIR/litellm.log)..."
  nohup $LITELLM_BIN --config "$DIR/config.yaml" --port "$PORT" --host 0.0.0.0 > "$DIR/litellm.log" 2>&1 &
  echo $! > "$DIR/litellm.pid"
  if wait_ready "http://127.0.0.1:$PORT" 60; then
    finish "http://127.0.0.1:$PORT"
    [ -n "\${DATABASE_URL:-}" ] || echo "  no database behind it, so it has no keys of its own: agents call it with the master key. stop it: kill \\$(cat $DIR/litellm.pid)"
  else
    echo "litellm.sh: the proxy did not answer on port $PORT within three minutes; $DIR/litellm.log says why." >&2
    exit 1
  fi
  exit 0
fi

# ----------------------------------------------------------- kubernetes
if [ "$WHERE" = kubernetes ]; then
  command -v kubectl >/dev/null 2>&1 || { echo "litellm.sh: kubectl is not installed here." >&2; exit 1; }
  CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  [ -n "$CONTEXT" ] || { echo "litellm.sh: kubectl has no current context - no cluster to apply to." >&2; exit 1; }
  echo "Applying to namespace $NAMESPACE on $CONTEXT..."
  kubectl apply -k "$DIR"
  echo "Waiting for the proxy to be ready (it runs its database migrations first)..."
  kubectl -n "$NAMESPACE" rollout status deployment/litellm --timeout=300s || {
    echo "litellm.sh: the proxy is not ready yet; 'kubectl -n $NAMESPACE logs deploy/litellm' says why." >&2
    exit 1
  }
  finish "http://litellm.$NAMESPACE.svc:4000"
  echo "  from outside the cluster: kubectl -n $NAMESPACE port-forward svc/litellm 4000:4000   (then http://127.0.0.1:4000)"
  echo "  the address above is the in-cluster one; an Ingress in front of svc/litellm gives it a public name."
  exit 0
fi

# ------------------------------------------------------------------ fly
if [ "$WHERE" = fly ]; then
  FLY="fly"
  command -v fly >/dev/null 2>&1 || FLY="flyctl"
  command -v "$FLY" >/dev/null 2>&1 || { echo "litellm.sh: flyctl is not installed here (https://fly.io/docs/flyctl/install/)." >&2; exit 1; }
  [ -n "$APP" ] || APP="litellm-$(random_key | cut -c1-6)"
  [ -n "$REGION" ] || REGION="\${FLY_REGION:-iad}"
  cat > fly.toml <<CV_FILE
# Written by $ORIGIN/litellm.sh: LiteLLM on Fly, its keys as Fly secrets.
app = "$APP"
primary_region = "$REGION"

[build]
  image = "${IMAGE()}"

[env]
  STORE_MODEL_IN_DB = "True"
  PORT = "4000"

[[files]]
  guest_path = "/app/config.yaml"
  local_path = "config.yaml"

[processes]
  app = "--config /app/config.yaml --port 4000"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  # Named, or flyctl refuses the config: a service on an app with a
  # process group must say which group serves it.
  processes = ["app"]

  [[http_service.checks]]
    interval = "15s"
    timeout = "5s"
    # The most flyctl allows a service check; the proxy is up well within it.
    grace_period = "60s"
    method = "GET"
    path = "/health/liveliness"

[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
CV_FILE
  echo "Creating Fly app $APP in $REGION..."
  "$FLY" apps create "$APP" >/dev/null
  echo "Creating a Postgres for it ($APP-db)..."
  "$FLY" postgres create --name "$APP-db" --region "$REGION" --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1 --password "$DB_PASSWORD" >/dev/null
  "$FLY" postgres attach "$APP-db" --app "$APP" --yes >/dev/null
  # The .env as secrets, but for the port (an env) and DATABASE_URL (attach set it).
  grep -v '^#' .env | grep -v '^LITELLM_PORT=' | grep -v '^POSTGRES_PASSWORD=' | grep -v '=$' | "$FLY" secrets import --app "$APP" --stage
  echo "Deploying..."
  "$FLY" deploy --app "$APP" --config fly.toml --ha=false
  finish "https://$APP.fly.dev" "$APP"
  exit 0
fi

echo "litellm.sh: nowhere to start it (--$WHERE?)" >&2
exit 2
`;
}
