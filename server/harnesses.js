// A harness: what an agent's work runs in.
//
// The loop that ships with this app, Claude Code on the owner's own
// subscription, Codex, OpenCode, something of the person's own - each is a
// way of turning a model into a process that edits files and calls tools,
// and each does it differently enough that "which agent" is only half of
// "who did this". The Performance page ranks harnesses beside agents for
// that reason, and it can only do that if a harness is a thing with a name
// and an id rather than a word on a resident's record.
//
// So a harness is a record of the person's: what kind it is, how it is
// launched (for one that runs in a sandbox), how its MCP configuration is
// written, which secret it needs (for Claude Code, the owner's token - the
// one `model`-class secret this app ever puts in a sandbox, see
// claude-code.js), and where it runs. A resident agent names the harness
// it runs in; one that names none runs in the owner's default; an owner
// with no records at all gets the built-in loop, or Claude Code if they
// have a `CLAUDE_CODE_OAUTH_TOKEN` on the Secrets page - which is exactly
// what happened before harnesses existed, so nothing changes for anybody
// the day this ships.
//
// A harness on the person's laptop is the other half. Claude Code running
// in a terminal is not started by this app and cannot be; what it can do
// is *report* here - its OpenTelemetry export, pointed at this app with a
// harness token, becomes a session on the Activity page like any resident's
// (telemetry-ingest.js). The token is minted with the record, shown once,
// and stored hashed like an agent's token is (repos.js): it
// authorises the ingest routes and nothing else, so a leaked one lets
// somebody write noise into the log, not read a file.
//
// A laptop harness usually reports *for* an agent: the person invited one
// on the Agents page, ran `claude mcp add` with its token, and Claude Code
// in that terminal is both the agent making MCP calls here and the harness
// sending its telemetry. Those arrived as two strangers - an `invited`
// session under the agent's name and a `harness` session under the
// harness's - and nothing joined them. So a harness may name the agent it
// reports for (`agent`), and its sessions are then that agent's: the
// Activity page shows the agent's name, its pull requests are the agent's,
// its model calls cost against the agent, and the box on the Home page
// reaches it on the agent's private line. The wizard sets this when it
// mints the two tokens together; an agent's page offers it afterwards.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { read as readRow, patch as patchRow } from "./user-record.js";
import { setupCommand } from "./setup-script.js";
import { litellmCommand } from "./litellm-command.js";
import { funName } from "./agent-names.js";

export class HarnessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** How many harnesses one account may keep, beside the built-in one. */
export const MAX_HARNESSES = Number(process.env.CODERVIBES_MAX_HARNESSES ?? 8);

/** The secret Claude Code runs on - `claude setup-token` prints it. */
export const CLAUDE_CODE_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * The kinds, and what each is unless the record says otherwise. `mcp` is
 * how the harness wants this app's tools declared to it; `secret` is the
 * one secret it needs placed where it runs; `sandbox` says whether this
 * app can run it inside a sandbox at all - the loop and Claude Code it can,
 * the rest are things a person runs on their own machine for now.
 *
 * `resume` is how that harness is told to carry on a session it already
 * has, as `<command> <args...> <the harness's own session id>` - what the
 * session page hands somebody so the work can be picked up rather than
 * started again (index.js `resumeOf`). It lives here rather than on the
 * page for the reason the MCP formats do: what a person is told to type
 * and what the harness actually accepts must not drift apart, and there is
 * one place to fix when a CLI changes its flag. Null where there is
 * nothing to type: the loop this app ships is not something a person runs
 * in a terminal, and a harness of somebody's own is theirs to know.
 */
export const KINDS = Object.freeze({
  agentd: {
    label: "CoderVibes loop",
    note: "The loop that ships with this app, through its own inference door.",
    mcp: "none",
    secret: null,
    sandbox: true,
    launch: null,
    resume: null,
  },
  "claude-code": {
    label: "Claude Code",
    note: "Anthropic's Claude Code, on the owner's own subscription.",
    mcp: "claude",
    secret: CLAUDE_CODE_SECRET,
    sandbox: true,
    launch: { command: "claude", args: ["-p", "--output-format", "stream-json"] },
    resume: { command: "claude", args: ["--resume"] },
  },
  codex: {
    label: "Codex",
    note: "OpenAI's Codex CLI.",
    mcp: "codex-toml",
    secret: null,
    sandbox: false,
    launch: { command: "codex", args: ["exec"] },
    resume: { command: "codex", args: ["resume"] },
  },
  opencode: {
    label: "OpenCode",
    note: "OpenCode.",
    mcp: "opencode-json",
    secret: null,
    sandbox: false,
    launch: { command: "opencode", args: ["run"] },
    resume: { command: "opencode", args: ["run", "--session"] },
  },
  custom: {
    label: "Something else",
    note: "A harness of your own; say how it is launched.",
    mcp: "none",
    secret: null,
    sandbox: false,
    launch: null,
    resume: null,
  },
});

/** The MCP configuration formats a harness can be handed - see `connect`. */
export const MCP_FORMATS = ["claude", "codex-toml", "opencode-json", "none"];

/** Where a harness runs: a sandbox this app opens, or the person's own machine. */
export const WHERE = ["sandbox", "laptop"];

/**
 * The harness every account has without making one: the loop. It has no
 * token - a resident reaches this app with its own credential - and no
 * record, so it cannot be forgotten or made anything but what it is.
 */
export const BUILT_IN = Object.freeze({
  id: "agentd",
  name: "CoderVibes loop",
  kind: "agentd",
  where: "sandbox",
  launch: null,
  secret: null,
  mcp: { format: "none", extra: [] },
  sandboxTemplate: null,
  telemetry: { otlp: false },
  builtIn: true,
  default: false,
  createdAt: null,
  lastSeenAt: null,
});

/**
 * The harness an owner with no records gets when they have put a Claude
 * Code token on their Secrets page: what claude-code.js did before there
 * were records. Not stored; it stops existing the day they make a record.
 */
export const IMPLIED_CLAUDE_CODE = Object.freeze({
  ...BUILT_IN,
  id: "claude-code",
  name: "Claude Code",
  kind: "claude-code",
  launch: KINDS["claude-code"].launch,
  secret: CLAUDE_CODE_SECRET,
  mcp: { format: "claude", extra: [] },
});

// ---------------------------------------------------------------- tokens
//
// `cvh1.<account>.<secret>` - the same shape as a laptop's token, for the
// same reason: the users table is keyed by account, and a token that names
// its account can be checked without a scan.

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function sameSecret(a, b) {
  const left = Buffer.from(hash(a), "hex");
  const right = Buffer.from(hash(b), "hex");
  return timingSafeEqual(left, right);
}

const PREFIX = "cvh1";
const SEP = ".";
const encodeUser = (user) => Buffer.from(String(user), "utf8").toString("base64url");
const decodeUser = (encoded) => {
  try {
    const user = Buffer.from(String(encoded), "base64url").toString("utf8");
    return user.includes("@") ? user : null;
  } catch {
    return null;
  }
};

/** Take a token apart, or null for anything that is not one. */
export function parseToken(value) {
  const parts = String(value ?? "").split(SEP);
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const user = decodeUser(parts[1]);
  if (!user || !parts[2]) return null;
  return { user, secret: parts[2] };
}

/** Whether a bearer value is shaped like a harness token, before any lookup. */
export const looksLikeToken = (value) => String(value ?? "").startsWith(`${PREFIX}${SEP}`);

const mint = (user) => [PREFIX, encodeUser(user), randomBytes(24).toString("base64url")].join(SEP);

/**
 * A token in this shape for something that is not a harness record: a
 * machine this app boots reports on one (machine-reporting.js). The
 * plaintext is for the caller to hand out once; the hash is what it keeps.
 */
export function mintToken(user) {
  const token = mint(user);
  return { token, tokenHash: hash(parseToken(token).secret) };
}

/** Whether a kept hash is the one a presented token's secret makes. */
export const matchesToken = (tokenHash, token) => {
  const parsed = parseToken(token);
  return Boolean(tokenHash && parsed && sameSecret(tokenHash, hash(parsed.secret)));
};

/** An id safe to hand a shell as it is: what a harness's session ids actually look like. */
const plainId = (id) => /^[A-Za-z0-9._:-]+$/.test(id);

/**
 * What to type to carry on a session in the harness that ran it, or null
 * when there is nothing to type - a kind with no `resume` above, or a
 * harness that reported no session id of its own.
 *
 * The id is quoted only if it needs to be. A harness's session id is a
 * uuid, and quoting one anyway would make every command on the session
 * page read as a thing to be careful with rather than a thing to paste.
 */
export function resumeCommand(kind, harnessSessionId) {
  const spec = KINDS[kind]?.resume;
  const id = String(harnessSessionId ?? "").trim();
  if (!spec || !id) return null;
  const said = plainId(id) ? id : `'${id.replace(/'/g, `'\\''`)}'`;
  return [spec.command, ...spec.args, said].join(" ");
}

/**
 * How to pick a session up where it stopped: the harness's own session id
 * - the thing its CLI knows the conversation by - and the line to type, or
 * null when there is nothing to pick up.
 *
 * A session's `key` is `<harness id>:<the harness's own session id>`
 * (telemetry-ingest.js `sessionFor`), because that is what the next batch
 * of its events is matched on. Two things are not that and must not be
 * read as if they were: `unnamed`, the placeholder for a harness that
 * reported no id of its own, and a key belonging to something else that is
 * keyed - an MCP connection (`mcp:...`) or an external agent's work
 * (`<connector>:<pull>`) - neither of which is a conversation any CLI can
 * be told to carry on. So the key has to be this session's own harness's.
 *
 * None of this is a credential. What the id opens is a transcript on the
 * machine the work was done on, for somebody already on that machine.
 */
export function resumeFor(session, kind = session?.harness?.kind ?? null) {
  const harnessId = session?.harness?.id ?? null;
  const key = String(session?.key ?? "");
  if (!harnessId || !key.startsWith(`${harnessId}:`)) return null;
  const id = key.slice(harnessId.length + 1).trim();
  if (!id || id === "unnamed") return null;
  return { id, harness: kind ? KINDS[kind]?.label ?? kind : null, command: resumeCommand(kind, id) };
}

// --------------------------------------------------------------- records

const cleanName = (name) => String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 60);

/** A harness's launch spec, checked: a command and string arguments, or nothing. */
function cleanLaunch(launch, kind) {
  if (launch == null) return KINDS[kind].launch;
  if (typeof launch !== "object") throw new HarnessError("A launch spec is an object with a command and arguments");
  const command = String(launch.command ?? "").trim();
  if (!command) throw new HarnessError("A launch spec needs a command");
  const args = Array.isArray(launch.args) ? launch.args.map((arg) => String(arg)).slice(0, 32) : [];
  const model = launch.model ? String(launch.model).trim().slice(0, 80) : null;
  return { command: command.slice(0, 200), args, ...(model ? { model } : {}) };
}

function cleanMcp(mcp, kind) {
  const format = mcp?.format ?? KINDS[kind].mcp;
  if (!MCP_FORMATS.includes(format)) throw new HarnessError(`Not an MCP configuration format: ${format}`);
  const extra = Array.isArray(mcp?.extra) ? mcp.extra.map((entry) => String(entry).slice(0, 200)).slice(0, 16) : [];
  return { format, extra };
}

/**
 * The agent a laptop harness reports for: its id and its name, and nothing
 * else of what was handed in - the wizard passes the agent's MCP credential
 * beside these for the connect steps, and that must not land on a record.
 */
function cleanAgent(agent, where) {
  if (agent == null) return null;
  if (where !== "laptop") throw new HarnessError("A harness in a sandbox reports for whichever resident runs it; only one on your own machine names an agent");
  const id = String(agent.id ?? "").trim().slice(0, 80);
  if (!id) throw new HarnessError("Which agent does it report for? An id is needed");
  return { id, name: cleanName(agent.name) || null };
}

/** The account's harnesses as stored. */
async function stored(user) {
  if (!user) return [];
  const row = await readRow(user).catch(() => null);
  return (row?.harnesses ?? []).filter(Boolean);
}

/**
 * The account's harnesses: the built-in loop first, then the records, with
 * the implied Claude Code one in between when there are no records and a
 * token - so a page lists what `harnessFor` would pick from.
 */
export async function listFor(user) {
  const records = await stored(user);
  if (records.length) return [BUILT_IN, ...records];
  return (await impliedClaudeCode(user)) ? [BUILT_IN, IMPLIED_CLAUDE_CODE] : [BUILT_IN];
}

/**
 * Whether a token on the Secrets page, with no records to say otherwise,
 * implies Claude Code. Remembered for a minute per account, the way
 * claude-code.js did: the poll asks on every round.
 */
const REMEMBER_MS = 60_000;
const remembered = new Map();
async function impliedClaudeCode(user) {
  const kept = remembered.get(user);
  if (kept && Date.now() - kept.at < REMEMBER_MS) return kept.implied;
  let implied = false;
  try {
    // Asked for here, not at the top of the file: the secret store is the
    // connector store underneath, and an installation with no keys in it
    // should not load either to answer "no".
    const { has: hasSecret } = await import("./secrets.js");
    implied = await hasSecret(user, CLAUDE_CODE_SECRET);
  } catch {
    // A store that cannot be asked is no token.
  }
  remembered.set(user, { implied, at: Date.now() });
  return implied;
}

/** Forget what was remembered about an account's token - it changed, or a test needs a clean start. */
export function forget(user = null) {
  if (user == null) remembered.clear();
  else remembered.delete(user);
}

export async function findFor(user, id) {
  const wanted = String(id ?? "").trim();
  if (!wanted) return null;
  return (await listFor(user)).find((entry) => entry.id === wanted) ?? null;
}

/** The harness that reports for an agent, if the owner made one for it. */
export async function findForAgent(user, agentId) {
  const wanted = String(agentId ?? "").trim();
  if (!wanted) return null;
  return (await stored(user)).find((entry) => entry.agent?.id === wanted) ?? null;
}

/**
 * Make one. Returns the record and, for one that runs on a laptop and
 * reports here, the token - once. A harness that runs in a sandbox needs
 * none: the resident's own credential reaches this app.
 *
 * @param {string} user
 * @param {{name?: string, kind: string, where?: string, launch?: object, mcp?: object,
 *   sandboxTemplate?: string|null, default?: boolean, agent?: {id: string, name?: string}|null}} spec
 */
export async function create(user, spec = {}) {
  if (!user) throw new HarnessError("Nobody is signed in", 401);
  const kind = String(spec.kind ?? "").trim();
  if (!KINDS[kind]) throw new HarnessError(`Not a harness kind: ${kind || "(none)"}. One of ${Object.keys(KINDS).join(", ")}.`);
  const where = spec.where ?? (KINDS[kind].sandbox ? "sandbox" : "laptop");
  if (!WHERE.includes(where)) throw new HarnessError(`A harness runs in a sandbox or on a laptop, not "${where}"`);
  if (where === "sandbox" && !KINDS[kind].sandbox) {
    throw new HarnessError(`${KINDS[kind].label} cannot be run in a sandbox by this app yet; it can run on your own machine and report here.`);
  }
  const asked = cleanName(spec.name);
  const agent = cleanAgent(spec.agent, where);

  const records = await stored(user);
  if (records.length >= MAX_HARNESSES) {
    throw new HarnessError(`You have ${MAX_HARNESSES} harnesses, which is the limit. Forget one first.`, 403);
  }
  // Nothing given used to become the kind's label - so a second Claude Code
  // was refused for being called what the first one was called, and the
  // list read as a column of one word repeated. A name of its own instead
  // (agent-names.js), drawn against the ones already here.
  const name = asked || funName(records.map((entry) => entry.name));
  if (records.some((entry) => entry.name === name)) throw new HarnessError(`You already have a harness called '${name}'`, 409);

  const id = `h_${randomBytes(4).toString("hex")}`;
  const token = where === "laptop" ? mint(user) : null;
  const record = {
    id,
    name,
    kind,
    where,
    launch: where === "sandbox" ? cleanLaunch(spec.launch, kind) : null,
    secret: KINDS[kind].secret,
    mcp: cleanMcp(spec.mcp, kind),
    sandboxTemplate: spec.sandboxTemplate ? String(spec.sandboxTemplate).slice(0, 80) : null,
    telemetry: { otlp: where === "laptop" },
    // Absent on a record that reports for nobody in particular, rather than
    // null, so a record written before this field existed reads the same.
    ...(agent ? { agent } : {}),
    tokenHash: token ? hash(parseToken(token).secret) : null,
    // The first one made is the default; after that it is a choice.
    default: Boolean(spec.default) || !records.some((entry) => entry.default),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  const next = record.default ? records.map((entry) => ({ ...entry, default: false })) : records;
  await patchRow(user, { harnesses: [...next, record] });
  return { harness: record, token };
}

/** Make one the default: what a resident with no harness of its own runs in. */
export async function setDefault(user, id) {
  const records = await stored(user);
  if (!records.some((entry) => entry.id === id)) throw new HarnessError(`No harness of id '${id}'`, 404);
  await patchRow(user, { harnesses: records.map((entry) => ({ ...entry, default: entry.id === id })) });
  return records.find((entry) => entry.id === id);
}

/**
 * Forget one. Its token stops working with the record; a resident that
 * named it falls back to the default on its next start, which the page
 * says.
 */
export async function remove(user, id) {
  const records = await stored(user);
  const gone = records.find((entry) => entry.id === id);
  if (!gone) throw new HarnessError(`No harness of id '${id}'`, 404);
  const rest = records.filter((entry) => entry.id !== id);
  if (gone.default && rest.length) rest[0] = { ...rest[0], default: true };
  await patchRow(user, { harnesses: rest });
  return gone;
}

/** A harness was heard from - its telemetry arrived. Written at most once a minute. */
export async function seen(user, id, at = Date.now()) {
  const records = await stored(user);
  const record = records.find((entry) => entry.id === id);
  if (!record) return null;
  if (record.lastSeenAt && at - Date.parse(record.lastSeenAt) < REMEMBER_MS) return record;
  const next = records.map((entry) => (entry.id === id ? { ...entry, lastSeenAt: new Date(at).toISOString() } : entry));
  await patchRow(user, { harnesses: next });
  return next.find((entry) => entry.id === id);
}

/**
 * Whether a bearer token is one of somebody's harnesses.
 *
 * @returns {Promise<{user: string, harness: object}|null>}
 */
export async function authenticate(token) {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const wanted = hash(parsed.secret);
  const harness = (await stored(parsed.user)).find((entry) => entry?.tokenHash && sameSecret(entry.tokenHash, wanted));
  return harness ? { user: parsed.user, harness } : null;
}

// -------------------------------------------------------------- choosing

/**
 * The harness an owner's resident runs in: the one it names, else the
 * owner's default, else the built-in loop - or Claude Code, implied by a
 * token, for an owner who has never made a record (the essay). A named
 * harness that has since been forgotten, or that cannot run in a sandbox,
 * is the default again rather than an error: the process has to start.
 */
export async function harnessFor(owner, agent = null) {
  const wanted = agent?.resident?.harnessId ?? agent?.harnessId ?? null;
  const all = await listFor(owner);
  const named = wanted ? all.find((entry) => entry.id === wanted && entry.where === "sandbox") : null;
  if (named) return named;
  const chosen = all.find((entry) => entry.default && entry.where === "sandbox");
  if (chosen) return chosen;
  if (all.includes(IMPLIED_CLAUDE_CODE)) return IMPLIED_CLAUDE_CODE;
  return BUILT_IN;
}

/**
 * The engine word the loop in the sandbox understands (agentd.mjs reads
 * `CODERVIBES_ENGINE`): Claude Code when the harness is that and its
 * secret is there, the loop's own otherwise - a Claude Code harness whose
 * owner removed the token runs on the API rather than not at all.
 */
export const engineOf = (harness, { hasSecret = true } = {}) =>
  harness?.kind === "claude-code" && hasSecret ? "claude-code" : "api";

/** What a browser is shown. Never the token hash. */
export const describeHarness = (harness) => ({
  id: harness.id,
  name: harness.name,
  kind: harness.kind,
  kindLabel: KINDS[harness.kind]?.label ?? harness.kind,
  where: harness.where,
  launch: harness.launch ?? null,
  secret: harness.secret ?? null,
  mcp: harness.mcp ?? { format: "none", extra: [] },
  sandboxTemplate: harness.sandboxTemplate ?? null,
  telemetry: harness.telemetry ?? { otlp: false },
  agent: harness.agent ? { id: harness.agent.id, name: harness.agent.name ?? null } : null,
  builtIn: Boolean(harness.builtIn),
  implied: harness === IMPLIED_CLAUDE_CODE,
  default: Boolean(harness.default),
  createdAt: harness.createdAt ?? null,
  lastSeenAt: harness.lastSeenAt ?? null,
});

// ------------------------------------------------------------ connecting

/**
 * The LiteLLM connector's steps, for its page under Connectors.
 *
 * One step, now, and only for an installation that has no proxy of its own
 * yet: the line that deploys one. Everything else that used to be here has
 * gone somewhere better.
 *
 * **The executor line is not here.** There is one way to set an executor up
 * - `setup.sh <token>`, from the Executors page - and it configures whatever
 * the installation has, proxy included, with no flag to know about
 * (setup-script.js). A second variant of that line living on this page was a
 * second thing to get wrong, and it meant the answer to "how do I set up an
 * executor" depended on which page you happened to be reading.
 *
 * **The reporting variables are not here either.** They were three lines to
 * paste into a proxy's environment, offered as though this installation were
 * one OTLP destination among several a person might be choosing between. It
 * is the destination: deploy/litellm/README.md says how to point a proxy
 * that already exists at it, in full, which is where a page-and-a-half of
 * environment variables belongs.
 */
export function connectLitellm({ origin, token = null } = {}) {
  const bearer = token ?? "<your ingest token>";
  return {
    steps: [
      {
        id: "stand-up",
        title: "Deploy one",
        note:
          "One line, run where the proxy should live - `--fly` for one this installation can then run itself, or " +
          "docker compose here by default. It prints the two installation secrets that hand it over.",
        snippet: litellmCommand({ origin, token: bearer, where: "fly" }),
      },
    ],
  };
}

/**
 * How somebody makes their own setup report here, for the Executors page.
 *
 * One line. It is the whole of what this app asks of a person: this app
 * does not start their agent, so there is nothing to configure and nothing
 * to wait for - run this where the agent runs, and the next session shows
 * up. The line is the setup script (setup-script.js), which configures
 * every harness it knows - Claude Code, Codex, Gemini CLI, and the standard
 * OpenTelemetry variables for the rest - works out where it is (a laptop,
 * an e2b sandbox, a Niteshift environment; machine-source.js confirms it),
 * and reports the machine here so it is on the page before its first
 * session. The same line serves a laptop and a sandbox because the thing
 * being configured is the harness, not the box it is in.
 *
 * There used to be more steps here - a settings file to merge by hand, a
 * sandbox variant with a flag saying which platform, an OTLP header for other
 * harnesses. Each was a thing to read past for everybody it did not apply
 * to, and the script does all of them.
 *
 * `token` is the account's ingest token, always real: it is kept (ingest-
 * token.js), because a setup line with a placeholder in it is not one. Null
 * is an installation that authenticates nobody (edition.js): the line is the
 * bare one, and the only place offered is the machine it is running on -
 * every other preset is a platform that builds a machine somewhere else and
 * takes the token as a secret to paste, and there is neither a token to
 * paste nor anywhere else that could reach this.
 */
export function connectYourOwn({ origin, token }) {
  const command = setupCommand({ origin, token });
  const places = (token ? PLACES : PLACES.slice(0, 1)).map((place) => ({
    id: place.id,
    label: place.label,
    hint: place.hint,
    steps: place.steps({ origin, token, command }),
  }));
  return {
    command,
    scriptUrl: `${origin}/setup.sh`,
    places,
    // The laptop's steps, unqualified, for everything that reads `steps`
    // without asking where: an agent's page, and anybody who wants the line
    // and nothing else.
    steps: places[0].steps,
  };
}

/**
 * Where somebody is putting this, and what they have to do there.
 *
 * One line is the whole of it on a laptop, and on a laptop that is the
 * truth. On a platform that builds the machine for you it is not: the line
 * is not something you run, it is something you put in that platform's own
 * pre-agent hook, and the token is not an argument, it is a secret you paste
 * into a field. A dialog that showed only the laptop's line left the reader
 * to work that translation out, and the translation is where the time goes -
 * every one of these steps is a thing somebody got wrong first.
 *
 * These are presets, in the shape `external-agents/presets.js` already uses
 * for the same reason: naming a platform's own words is what makes an
 * instruction followable, and a preset is where a vendor's particulars are
 * allowed to live.
 */
const PLACES = [
  {
    id: "machine",
    label: "Your machine",
    hint: "A laptop, a desktop, a server you keep - anywhere you run the agent yourself.",
    steps: ({ token, command }) => [
      {
        title: "Run this where your agent runs",
        // Which agents it sets up, and how far, is the grid's answer now
        // (console-integrations.js): naming three of them here was the
        // sentence that read as "yours too" to everybody using a fourth.
        // What is left is what the grid cannot say - that the line finds its
        // own way and can be run twice.
        note:
          "It works out where it is and what is installed there, and is safe to run again. " +
          (token
            ? "Everything it sets up reports on this token, and gets this app's tools with it - your repos' tasks, " +
              "and the services you connected - as an MCP server named codervibes."
            : // No token to name and no tools to hand over: say what it does
              // do instead, rather than a sentence with the nouns taken out.
              "Everything it sets up reports here. It carries no token - this CoderVibes answers on this machine only - and " +
              "it does not touch which model your harness calls or where it sends it."),
        snippet: command,
      },
    ],
  },
  {
    id: "niteshift",
    label: "Niteshift",
    hint: "An environment Niteshift builds and rebuilds for you; the agent starts in it.",
    steps: ({ origin, token }) => [
      {
        title: "Put the token in the environment's variables",
        note:
          "In Niteshift: Settings -> Environments -> your environment -> Environment variables -> Setup script -> Add " +
          "variable. Call it CODERVIBES_TOKEN and paste this as the value. It is a secret, which is why it goes here and " +
          "not in the file below.",
        snippet: token,
      },
      {
        title: "Commit .niteshift/setup to the repository",
        note:
          "Niteshift runs that file as root on a fresh environment, before the agent it launches starts - which is the " +
          "only moment that works, because a harness reads its hooks when it launches. A line run from inside a task is " +
          "a line run too late.",
        snippet: niteshiftSetup(origin),
      },
      {
        title: "Rebuild the environment cache",
        note:
          "Niteshift starts tasks from a prepared image and re-runs setup only when that image is built, so an " +
          "environment cached before the token existed keeps starting without it. Press the rebuild button beside " +
          "Environment cache. Only needed when the token changes.",
      },
    ],
  },
  {
    id: "e2b",
    label: "An e2b sandbox",
    hint: "A sandbox you start yourself, or one this app starts for you.",
    steps: ({ command }) => [
      {
        title: "Run it before the agent starts",
        note:
          "In the sandbox's own first command - e2b's `commands.run`, or a RUN line in the template you build from. " +
          "Before the agent, for the same reason as anywhere else: hooks are read at launch.",
        snippet: command,
      },
    ],
  },
  {
    id: "image",
    label: "A Dockerfile or CI",
    hint: "An image you build, or a job that starts the agent.",
    steps: ({ origin }) => [
      {
        title: "Take the token from the environment, not the file",
        note:
          "An image is copied and a pipeline's logs are read, so the token comes from your own secret store as " +
          "CODERVIBES_TOKEN and the line that runs is the same one. The script reads it from the environment when it is " +
          "not given an argument.",
        snippet: `CODERVIBES_TOKEN=<from your secret store> \\\n  sh -c 'curl -fsSL ${origin}/setup.sh | sh'`,
      },
    ],
  },
];

/** What `.niteshift/setup` has to have in it, as this repository's own does. */
const niteshiftSetup = (origin) =>
  [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Whatever this environment needs installed goes here too.",
    "",
    "if [ -n \"${CODERVIBES_TOKEN:-}\" ]; then",
    `  curl -fsSL ${origin}/setup.sh | sh`,
    "else",
    "  echo \"codervibes: no CODERVIBES_TOKEN - this sandbox will not report\" >&2",
    "fi",
  ].join("\n");

/**
 * The steps to connect a harness, for its page. `token` is the harness's,
 * given only at creation - afterwards the steps show a placeholder, since
 * the token is shown once. `agent` is an invited agent's MCP credential
 * `{url, token}`, when the caller minted one alongside, for the line that
 * gives the harness this app's tools - and with it that line comes first,
 * since a person who just invited an agent is asking how to connect *it*;
 * the telemetry is what they get on top.
 */
export function connect(harness, { origin, token = null, agent = null } = {}) {
  const steps = [];
  const bearer = token ?? "<your harness token>";
  const tools = agent
    ? {
        title: "Give it this app's tools",
        note: "The repo's tasks and pull requests, as the agent you just invited - on the agent's own token.",
        snippet: mcpSnippet(harness, agent),
      }
    : harness.agent
      ? {
          title: "Give it this app's tools",
          note:
            `Already done if ${harness.agent.name ?? "the agent"} has connected: that is the MCP line it was invited with, on its own token. ` +
            "If that token is lost, it cannot be shown again - delete the agent and invite it afresh.",
          snippet: null,
        }
      : {
          title: "Give it this app's tools",
          note: "Invite an agent from the Agents page and run the command it shows; that is the MCP connection, on the agent's own token.",
          snippet: null,
        };
  if (agent && harness.where === "laptop") steps.push(tools);
  if (harness.where === "sandbox") {
    steps.push({
      title: "Nothing to connect",
      note:
        `${KINDS[harness.kind]?.label ?? harness.kind} runs inside the sandbox this app opens for a resident agent. ` +
        `Pick this harness on the agent's page; it is used the next time its process starts.`,
      snippet: null,
    });
    if (harness.secret) {
      steps.push({
        title: `Put ${harness.secret} on the Secrets page`,
        note: "The one secret this app places in a sandbox - the owner's own subscription, for the owner's own agents.",
        snippet: harness.kind === "claude-code" ? "claude setup-token" : null,
      });
    }
    return { steps };
  }

  if (harness.kind === "claude-code") {
    // The same line as the account's own setup (connectYourOwn), on this
    // harness's token. There used to be a settings file to merge by hand
    // here, with hooks written out as shell inside JSON; the script writes
    // the same file, and the hooks it installs send the whole session -
    // what was asked, each tool call, what was answered - which a
    // one-line hook never could.
    steps.push({
      title: "Run this where Claude Code runs",
      note:
        "It switches Claude Code's OpenTelemetry export on and points it here, and installs the hooks that report each session as it happens - " +
        "which repository, what was asked, every tool call and what the agent said - so the session reads here the way it read in the terminal. " +
        "Safe to run again.",
      snippet: setupCommand({ origin, token: bearer }),
    });
  } else {
    steps.push({
      title: "Send its telemetry here",
      note:
        `Point ${KINDS[harness.kind]?.label ?? "the harness"}'s OpenTelemetry export at ${origin}/otlp ` +
        `over OTLP/HTTP JSON with the header below. Anything shaped like Claude Code's events is read; the rest is counted and kept.`,
      snippet: `Authorization: Bearer ${bearer}`,
    });
  }
  // A LiteLLM proxy used to be a step here. It is a connector now, with a
  // page under Connectors: a proxy routes an executor's calls, it is not one.
  if (!agent) steps.push(tools);
  return { steps };
}

/** The MCP declaration in the harness's own format. */
export function mcpSnippet(harness, { url, token }) {
  const format = harness.mcp?.format ?? KINDS[harness.kind]?.mcp ?? "none";
  if (format === "claude") {
    return `claude mcp add --transport http codervibes ${url} --header "Authorization: Bearer ${token}"`;
  }
  if (format === "codex-toml") {
    return [`[mcp_servers.codervibes]`, `url = "${url}"`, `http_headers = { Authorization = "Bearer ${token}" }`].join("\n");
  }
  if (format === "opencode-json") {
    return JSON.stringify({ mcp: { codervibes: { type: "remote", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  return `${url}\nAuthorization: Bearer ${token}`;
}

/** For the Secrets page: what a secret of this name is used by. */
export const usersOf = (name) => (name === CLAUDE_CODE_SECRET ? ["the resident agents, as Claude Code"] : []);
