// One token an account reports on, for the setups it runs itself.
//
// A harness token used to come with a harness *record*: you made one on the
// Account page, it was shown once, and it authorised that laptop's export.
// That was the right shape when this app also started agents - a record was
// the thing you picked on an agent's page - and it is the wrong shape now
// that starting them is somebody else's job. The question a person arrives
// with is "how do I get my Claude Code seen here", and the honest answer is
// one line with a token in it, not a wizard that first asks them to declare
// a thing.
//
// So an account has one ingest token. It is minted the first time the
// Executors page asks, kept on the owner's row beside the harnesses
// (harnesses.js made the same move), and used by every setup that person
// runs: the laptop, the e2b sandbox, the second laptop. It authorises two
// things, both of them the person's own: the ingest, and this app's MCP
// endpoint (mcp.js `reachableBy`), where it is the person - their repos,
// their connectors - so the same setup line that makes their Claude Code
// report here also hands it their Linear and their e2b. That second door
// is why it is worth guarding: a leaked one used to let somebody write
// noise into the log, and now lets them read what the owner connected and
// speak in their rooms (writes stay behind each connector's own switch).
// Rotating it closes both at once, from the same page.
//
// **It is kept, not just hashed.** A harness record's token is shown once
// and only its hash survives, which is right for a credential that reads
// things. This one writes counts into a log, and the page that hands it
// over is opened every time somebody has a new machine - so a page that
// said "the token was shown once, take a new one" was, in practice, a page
// that rotated the token on every visit and broke the previous machine.
// The plaintext is kept encrypted at rest (crypto-at-rest.js, the same
// cipher the connector credentials use) beside the hash the ingest checks,
// and the setup line always carries the real token. A row from before this
// was kept has no plaintext to show, and is minted afresh rather than shown
// as a placeholder forever.
//
// It is in the harness token shape (`cvh1.<account>.<secret>`) because
// otlp.js already knows how to take one apart without a scan, and because a
// setup reporting on it should look like exactly what it is: a harness this
// app did not start.
//
// **The token is the executor.** Telling two setups apart used to be the
// report's job - the script said which machine it ran on, the hook said it
// again, and a laptop and a sandbox were two machines under one token. That
// works while a machine's name is a fact about a lasting thing, and it falls
// apart where the thing is rebuilt: a Niteshift environment is one agent that
// gets a fresh sandbox id every night, so a name-keyed row became a new,
// unrecognisable executor every day and no machine kept a history worth
// reading. Naming the machine by hand fixes the symptom and leaves the
// premise wrong.
//
// So the row is keyed by the token instead, through an `executorId` minted
// with it and stable for its life. A setup on a token is that token's
// executor whatever the machine happens to be called today; the name it
// reports is this incarnation's label, and `seen` keeps the last few, so a
// token used from two places at once is visible rather than silently
// interleaved. Rotating still invalidates everything on the old token,
// because that is what rotating means - and the new token is a new executor,
// which is the honest reading of "I replaced the credential this thing
// registered with".
//
// An account still has one of these today, so every setup it has ever run is
// one executor: the laptop, the second laptop, the sandboxes. That is the
// merge, and it needs no migration - the rows converge the moment the id
// stops coming from the name. A token per executor is the next step, and
// this is the half that has to be true first.
import { randomBytes } from "node:crypto";
import { mintToken, matchesToken, parseToken } from "./harnesses.js";
import { encrypt, decrypt } from "./crypto-at-rest.js";
import { field, patch } from "./user-record.js";
import { MAX_EXECUTORS } from "./edition.js";

const FIELD = "ingest";
const SETUPS = "setups";

/** How many machines one account's setup script may register before the oldest is forgotten. */
export const MAX_SETUPS = 50;

/** How many incarnations of one executor are remembered - enough to see an alternation. */
export const MAX_SEEN = 10;

/** What the row keeps. */
const kept = (row) =>
  row?.tokenHash
    ? { tokenHash: row.tokenHash, token: row.token ?? null, mintedAt: row.mintedAt ?? null, executorId: row.executorId ?? null }
    : null;

/**
 * The demo's token: a sample, so the setup line on the demo's Executors
 * page reads as it would for somebody signed in, with a token in it.
 *
 * A visitor has no account and so nothing to mint a token for, and the
 * panel that asked for one sat on "Reading your token…" for good. This is
 * the token shape (`cvh1.<account>.<secret>`) on an account nobody has,
 * with a secret that says what it is - so the line looks right, a visitor
 * who runs it anyway is refused at the door with a clear message rather
 * than quietly reporting into the demo, and nothing on this installation
 * ever authenticates it: `authenticate` refuses it by name before looking
 * anything up, and there is no row for its account to match in any case.
 */
export const DEMO_OWNER = "demo@example.com";
export const DEMO_TOKEN = `cvh1.${Buffer.from(DEMO_OWNER, "utf8").toString("base64url")}.sample-not-a-credential`;

/** What /api/ingest answers a visitor reading the demo: the sample, said to be. */
export const sample = () => ({ token: DEMO_TOKEN, mintedAt: null, demo: true });

/** An executor's id: minted with its token, and what its machine is filed under. */
const newExecutorId = () => `exe_${randomBytes(9).toString("base64url")}`;

/**
 * The executor id on a row, assigning one to a row minted before there were
 * any. Assigned lazily and written back, so the first setup after this lands
 * settles it and every setup after joins the same row - including the ones
 * already on the page, which is how the machines an account ran before this
 * become the one executor they always were.
 */
async function executorIdFor(owner, row) {
  if (row?.executorId) return row.executorId;
  const executorId = newExecutorId();
  await patch(owner, { [FIELD]: { ...row, executorId } });
  return executorId;
}

/** The account's ingest token as the row holds it, or null when it has never had one. */
export async function storedFor(owner) {
  if (!owner) return null;
  return kept(await field(owner, FIELD, null));
}

/** The plaintext, off a row that has one. Null for a row from before it was kept. */
function shown(row) {
  if (!row?.token) return null;
  try {
    return decrypt(row.token);
  } catch {
    // Encrypted under a secret this process no longer has. The token still
    // authenticates by its hash; it just cannot be shown, and `ensure`
    // treats that like a row that never kept it.
    return null;
  }
}

/**
 * Mint one, replacing whatever was there.
 *
 * A second call is a rotation, and every setup on the old token stops being
 * heard - which is the point of asking for one.
 */
export async function mint(owner) {
  if (!owner) throw new Error("An ingest token belongs to an account");
  const { token, tokenHash } = mintToken(owner);
  // A new token is a new executor: whatever registered on the old one is not
  // this, and letting it inherit the history would be the one lie this
  // scheme can tell.
  const row = { tokenHash, token: encrypt(token), mintedAt: new Date().toISOString(), executorId: newExecutorId() };
  await patch(owner, { [FIELD]: row });
  return { token, tokenHash, mintedAt: row.mintedAt, executorId: row.executorId };
}

/**
 * The account's token, minting one if this is the first time anybody asked
 * - or if the one there cannot be shown, since a setup line with a
 * placeholder in it is not a setup line.
 *
 * The Executors page calls this, which is why it mints: a page that showed
 * "you have no token, press this" would be one press between a person and
 * the thing they came for, and there is nothing to decide.
 */
export async function ensure(owner) {
  const existing = await storedFor(owner);
  const token = shown(existing);
  if (existing && token) return { token, tokenHash: existing.tokenHash, mintedAt: existing.mintedAt };
  return mint(owner);
}

/**
 * Who a bearer token is, for the ingest. Null for one this account never
 * minted, or for one that has since been rotated past.
 *
 * The answer is harness *shaped* - otlp.js and telemetry-ingest.js file
 * everything under a harness - but there is no record behind it: the id is
 * the account's own door, and the session's real identity comes from the
 * machine the hook names and the agent the work is for.
 */
export async function authenticate(token) {
  // The demo's sample, by name: it is handed to every visitor, so it is the
  // one token guaranteed to be tried from somewhere it should not be.
  if (token === DEMO_TOKEN) return null;
  const parsed = parseToken(token);
  if (!parsed) return null;
  const row = await storedFor(parsed.user);
  if (!row || !matchesToken(row.tokenHash, token)) return null;
  return { user: parsed.user, harness: harnessOf(parsed.user), executor: await executorIdFor(parsed.user, row) };
}

/**
 * The harness id every setup on the account token reports under.
 *
 * One id for all of them on purpose: which *machine* a session ran on is the
 * session's to say (its `machine`, from the start hook), not the token's, and
 * that is what the Executors page groups a setup by. A token per machine
 * would be a second, worse answer to the same question - and one more thing
 * for a person to manage before they can be seen at all.
 */
export const HARNESS_ID = "ingest";

/** The harness a setup on the account token reports as. */
export const harnessOf = (owner) => ({
  id: HARNESS_ID,
  name: "Your own setup",
  kind: "claude-code",
  where: "laptop",
  account: true,
  owner,
});

// ---------------------------------------------------------------- setups
//
// The `setups` map on the owner's row is the one registry of machines this
// account has. It began as "what the setup script reported", which left a
// second, shadow registry beside it: a machine whose session hooks arrived
// but whose setup report never did (a settings file copied from another
// laptop, a sandbox image baked with ~/.codervibes in it) existed on the
// Executors page, assembled from sessions, and in no map. Two registries
// mean two answers to "how many machines is this", and only one of them
// can be counted. So a start hook registers its machine here too
// (`noteMachine`), and the map is the count.
//
// It being the count is what lets there be a cap. An installation that
// seats a fixed number of executors (edition.js `MAX_EXECUTORS`, which the
// local edition sets and the hosted product leaves at `Infinity`) refuses
// the machine that would be one too many, loudly: a 409 that says what the
// cap is and how to make room, and a line in the log. It is not dropped
// quietly and it is not let through - a state that should be impossible is
// denied and recorded, never deleted on the way past.

/**
 * Room for one more machine, or the refusal that says why not.
 *
 * A machine already in the map is always let through, whatever the cap:
 * the cap is on how many machines an account has, and a machine reporting
 * again is not a new one. Refusing it would turn a cap into a machine that
 * stops working the moment somebody else's row is full.
 */
function refuseIfFull(owner, all, machineId) {
  if (machineId in all) return;
  const held = Object.keys(all).length;
  if (held < MAX_EXECUTORS) return;
  console.warn(
    `refused a new machine for ${owner}: ${held} of ${MAX_EXECUTORS} places are taken`,
  );
  const error = new Error(
    `This CoderVibes seats ${MAX_EXECUTORS} executor${MAX_EXECUTORS === 1 ? "" : "s"} and all ` +
      `${MAX_EXECUTORS} are taken. Forget a setup on the Executors page to free a place, ` +
      `then connect this machine again.`,
  );
  error.status = 409;
  throw error;
}

/**
 * A machine the setup script ran on, before it has run anything.
 *
 * A setup used to exist here only once its first session arrived, which
 * left a person who had just run the line looking at an empty page,
 * wondering whether it worked. So the script reports itself when it
 * finishes - which machine, where it is, which harnesses it configured -
 * and the Executors page shows the machine from that moment, waiting for
 * its first session. The id is the one a session's start hook will use
 * (telemetry-ingest.js `whereOf`), so the session joins the same row.
 *
 * Throws a 409 when the machine is a new one and the account has no place
 * left for it - see `refuseIfFull`.
 *
 * @param {string} owner
 * @param {{machine: {id: string, name: string, host: string}, os?: string, harnesses?: string[], source?: string}} report
 */
export async function noteSetup(owner, { machine, os = null, harnesses = [], source = null }) {
  if (!owner || !machine?.id) return null;
  const all = await field(owner, SETUPS, {});
  refuseIfFull(owner, all, machine.id);
  const before = all[machine.id] ?? null;
  const now = new Date().toISOString();
  // Every machine this executor has been. Keyed by the token, the row
  // outlives the sandbox it is running in today, so the names are a history
  // rather than a contradiction - and the one thing they are worth reading
  // for is the case they cannot tell apart from a rebuild: one token in two
  // places, interleaving two machines' work on one row. A person looking at
  // a list of incarnations that alternate between two names can see that;
  // a row that only ever showed the latest could not.
  const seen = [...(before?.seen ?? [])].filter((entry) => entry.name !== machine.name || entry.host !== machine.host);
  seen.unshift({ name: machine.name, host: machine.host, at: now });
  const entry = {
    machine,
    os: String(os ?? "").trim().slice(0, 80) || null,
    harnesses: [...new Set((Array.isArray(harnesses) ? harnesses : []).map((name) => String(name).slice(0, 40)))].slice(0, 10),
    source: String(source ?? "").trim().slice(0, 80) || null,
    at: now,
    firstAt: before?.firstAt ?? now,
    seen: seen.slice(0, MAX_SEEN),
  };
  const next = { ...all, [machine.id]: entry };
  // Bounded: the oldest go, and a machine that ran setup a year ago and
  // never a session is not worth a row.
  const ids = Object.keys(next).sort((a, b) => Date.parse(next[a].at) - Date.parse(next[b].at));
  while (ids.length > MAX_SETUPS) delete next[ids.shift()];
  await patch(owner, { [SETUPS]: next });
  return entry;
}

/**
 * A machine a session said it ran on, registered whether or not the setup
 * script ever reported it.
 *
 * The session hooks are the other door into this account, and plenty of
 * machines come through it alone: a settings file copied from one laptop to
 * the next, a sandbox image baked with ~/.codervibes already in it, a
 * machine that ran the line while this app was down. Each of those is a
 * machine of this account's, and each used to be on the Executors page and
 * in no map - which made the map a count of "machines that reported setup"
 * rather than a count of machines, and a cap over it a cap over the wrong
 * number.
 *
 * So it registers a minimal entry: what the hook knows, which is the
 * machine and that it is here now. What it does not know - the OS, which
 * harnesses are installed, where the report came from - stays null rather
 * than being guessed, and the next setup report fills it in. A machine
 * already in the map is only touched, so a session never rewrites what the
 * setup script said about it.
 *
 * Throws a 409 when it is a new machine and there is no place for it.
 *
 * @param {string} owner
 * @param {{id: string, name: string, host: string}} machine
 */
export async function noteMachine(owner, machine) {
  if (!owner || !machine?.id) return null;
  const all = await field(owner, SETUPS, {});
  refuseIfFull(owner, all, machine.id);
  const now = new Date().toISOString();
  const before = all[machine.id] ?? null;
  const entry = before
    ? { ...before, at: now }
    : { machine, os: null, harnesses: [], source: null, at: now, firstAt: now, seen: [{ name: machine.name, host: machine.host, at: now }] };
  await patch(owner, { [SETUPS]: { ...all, [machine.id]: entry } });
  return entry;
}

/**
 * Forget a machine: the person saying that setup is over.
 *
 * The one way a place comes free under a cap, which is why the refusal
 * above names it. It removes the row and nothing else - the sessions that
 * ran on that machine are what happened and stay on the Activity page -
 * and the machine comes back if it reports again, which is the honest
 * behaviour: forgetting is not a block list.
 *
 * @returns {Promise<boolean>} whether there was one to forget.
 */
export async function forgetSetup(owner, machineId) {
  if (!owner || !machineId) return false;
  const all = await field(owner, SETUPS, {});
  if (!(machineId in all)) return false;
  const next = { ...all };
  delete next[machineId];
  await patch(owner, { [SETUPS]: next });
  return true;
}

/** Every machine the setup script has reported for this account, newest first. */
export async function setupsOf(owner) {
  if (!owner) return [];
  const all = await field(owner, SETUPS, {});
  return Object.values(all).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
