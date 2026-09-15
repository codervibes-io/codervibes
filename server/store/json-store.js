// File-backed persistence: two JSON documents next to the app.
//
// This is the default and needs no cloud account, which keeps `npm start`
// working on a laptop with nothing configured.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Where the documents sit. CODERVIBES_DATA_DIR moves the whole set, which is
// what lets a test run against a scratch directory instead of the real one -
// and what the local edition sets before anything here loads: server/local.js
// settles it on ~/.codervibes/data, so that a `git clean` or a second clone is
// not a month of sessions gone. Next to the app is only the fallback, which is
// what the full product on its own store runs on.
const root = process.env.CODERVIBES_DATA_DIR ?? path.join(here, "..", "..");

const REPOS_FILE = path.join(root, ".codervibes-repos.json");
// Who works with whom - see workspaces.js. Its own document rather than a
// field of each member's row, because a workspace is read as one thing (its
// member list) and written by whichever member invites the next.
const WORKSPACES_FILE = path.join(root, ".codervibes-workspaces.json");
// Kept out of the repos document because it holds OAuth tokens: separate
// file, owner-only mode, and one less thing to leak by pasting the other one.
const IDENTITIES_FILE = path.join(root, ".codervibes-github.json");
// What each person chose about how they work - see server/profile.js. Its own
// document because it is per user rather than per repo, and because it is
// written rarely and read on every session.
const PROFILES_FILE = path.join(root, ".codervibes-profiles.json");
// What happened lately - see events.js. Its own document because it is
// appended to constantly, and nothing else should be rewritten for it.
const EVENTS_FILE = path.join(root, ".codervibes-events.json");
/** How many events the file keeps. A day's catch-up on a laptop, not history. */
const EVENTS_KEPT = 5000;
// Spans and sessions - see spans.js and sessions.js. Appended to in batches
// and by a debounced writer respectively, and again nothing else is rewritten
// for them. Spans are capped by count as well as age: a busy day on a laptop
// is a few thousand, and the file is read whole.
const SPANS_FILE = path.join(root, ".codervibes-spans.json");
const SPANS_KEPT = 20000;
const SESSIONS_FILE = path.join(root, ".codervibes-sessions.json");
// What each session said and did, in order - see session-events.js. One
// file, capped by count like the spans: a session's log is a few hundred
// lines, and the last month's on a laptop fit in one read.
const SESSION_EVENTS_FILE = path.join(root, ".codervibes-session-events.json");
const SESSION_EVENTS_KEPT = 50000;
// The GitHub App's installations and the pull requests it hears about - see
// github-app.js and pulls.js. Small, and written when GitHub says something.
const INSTALLATIONS_FILE = path.join(root, ".codervibes-installations.json");
const PULLS_FILE = path.join(root, ".codervibes-pulls.json");
// What the workflow engines ran - see workflows.js. Pipelines and runs in
// one document, the runs capped by count: a run carries its steps and the
// tail of each step's log, and a laptop's month of them is a few thousand.
const WORKFLOWS_FILE = path.join(root, ".codervibes-workflows.json");
const WORKFLOW_RUNS_KEPT = 5000;
export class JsonStore {
  get name() {
    return "json";
  }

  /**
   * Nothing to check: the documents are created on first write, and a missing
   * one reads as empty rather than as an error. Present so callers do not have
   * to know which backend they have.
   */
  async check() {
    return [];
  }

  // ---------------------------------------------------------- repos

  async loadRepos() {
    return (await readJson(REPOS_FILE))?.repos ?? [];
  }

  /**
   * The file holds every repo in one document, so a write rewrites the
   * lot - but it rewrites what is *on disk* with this one change applied,
   * not the caller's snapshot of the world.
   *
   * That distinction is the whole point. Preparing a sandbox takes seconds and
   * saves when it finishes, by which time other repos have been created
   * and deleted; writing that stale set back deleted them. DynamoDB never had
   * the problem because it writes a single item, which is what this now
   * imitates.
   */
  async putRepo(repo, all) {
    await update(REPOS_FILE, (current) => {
      const merged = mergeById(current?.repos ?? all ?? [], repo);
      return { repos: merged };
    });
  }

  async deleteRepo(id) {
    await update(REPOS_FILE, (current) => ({
      repos: (current?.repos ?? []).filter((entry) => entry.id !== id),
    }));
  }

  // ------------------------------------------------------- workspaces

  async loadWorkspaces() {
    return (await readJson(WORKSPACES_FILE))?.workspaces ?? [];
  }

  async putWorkspace(workspace) {
    await update(WORKSPACES_FILE, (current) => ({
      workspaces: mergeById(current?.workspaces ?? [], workspace),
    }));
  }

  async deleteWorkspace(id) {
    await update(WORKSPACES_FILE, (current) => ({
      workspaces: (current?.workspaces ?? []).filter((entry) => entry.id !== id),
    }));
  }

  // ------------------------------------------------------------ profiles

  async loadProfile(user) {
    const all = (await readJson(PROFILES_FILE))?.profiles ?? [];
    return all.find((entry) => entry.user === user) ?? null;
  }

  /** Every row. For the orphan sweep, which has to know every account's free machines. */
  async loadProfiles() {
    return (await readJson(PROFILES_FILE))?.profiles ?? [];
  }

  async putProfile(profile) {
    await update(PROFILES_FILE, (current) => ({
      profiles: mergeById(current?.profiles ?? [], profile, "user"),
    }));
  }

  /** No record and a record saying "developer" are different states. */
  async deleteProfile(user) {
    await update(PROFILES_FILE, (current) => ({
      profiles: (current?.profiles ?? []).filter((entry) => entry.user !== user),
    }));
  }

  // ------------------------------------------------- github identities

  async loadIdentities() {
    return (await readJson(IDENTITIES_FILE))?.identities ?? [];
  }

  async putIdentity(identity, all) {
    await update(
      IDENTITIES_FILE,
      (current) => ({
        identities: mergeById(current?.identities ?? all ?? [], identity, "user"),
      }),
      { mode: 0o600 },
    );
  }

  async deleteIdentity(user) {
    await update(
      IDENTITIES_FILE,
      (current) => ({
        identities: (current?.identities ?? []).filter((entry) => entry.user !== user),
      }),
      { mode: 0o600 },
    );
  }

  // -------------------------------------------------------------- events

  async appendEvent(event) {
    await update(EVENTS_FILE, (current) => {
      const events = [...(current?.events ?? []), event];
      return { events: events.slice(-EVENTS_KEPT) };
    });
  }

  /** Events after `afterId`, oldest first, the ones that have expired left out. */
  async loadEvents(afterId, { limit = 500 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const events = (await readJson(EVENTS_FILE))?.events ?? [];
    return events
      .filter((event) => event.id > afterId && !(event.expires && event.expires < now))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }

  // --------------------------------------------------------------- spans

  async appendSpans(spans) {
    if (!spans?.length) return;
    const now = Math.floor(Date.now() / 1000);
    await update(SPANS_FILE, (current) => {
      const kept = [...(current?.spans ?? []), ...spans].filter((span) => !(span.expires && span.expires < now));
      return { spans: kept.slice(-SPANS_KEPT) };
    });
  }

  /** Spans of one session, task or trace, oldest first, the most recent `limit` of them. */
  async loadSpans({ session = null, task = null, trace = null, limit = 500 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const spans = (await readJson(SPANS_FILE))?.spans ?? [];
    const matching = spans
      .filter((span) => !(span.expires && span.expires < now))
      .filter((span) => (session ? span.session === session : task ? span.task === task : trace ? span.trace === trace : false))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    return matching.slice(Math.max(0, matching.length - limit));
  }

  // ------------------------------------------------------ session events

  async appendSessionEvents(entries) {
    if (!entries?.length) return;
    const now = Math.floor(Date.now() / 1000);
    await update(SESSION_EVENTS_FILE, (current) => {
      const kept = [...(current?.events ?? []), ...entries].filter((entry) => !(entry.expires && entry.expires < now));
      return { events: kept.slice(-SESSION_EVENTS_KEPT) };
    });
  }

  /** One session's log after `since`, oldest first, the first `limit` of them. */
  async loadSessionEvents({ session, since = 0, limit = 500 } = {}) {
    if (!session) return [];
    const now = Math.floor(Date.now() / 1000);
    const events = (await readJson(SESSION_EVENTS_FILE))?.events ?? [];
    return events
      .filter((entry) => entry.session === session && entry.seq > since && !(entry.expires && entry.expires < now))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  // ------------------------------------------------------------ sessions

  async putSession(session) {
    await update(SESSIONS_FILE, (current) => ({
      sessions: { ...(current?.sessions ?? {}), [session.id]: session },
    }));
  }

  async loadSession(id) {
    return (await readJson(SESSIONS_FILE))?.sessions?.[id] ?? null;
  }

  /** Sessions started since a moment, one owner's or everyone's, newest first. */
  async loadSessions({ owner = null, since = 0, limit = 200 } = {}) {
    const sessions = Object.values((await readJson(SESSIONS_FILE))?.sessions ?? {});
    return sessions
      .filter((session) => session.startedAt >= since && (!owner || session.owner === owner))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  // ------------------------------------------------------- installations

  async loadInstallations() {
    return Object.values((await readJson(INSTALLATIONS_FILE))?.installations ?? {});
  }

  async putInstallation(installation) {
    await update(INSTALLATIONS_FILE, (current) => ({
      installations: { ...(current?.installations ?? {}), [String(installation.id)]: installation },
    }));
  }

  async deleteInstallation(id) {
    await update(INSTALLATIONS_FILE, (current) => {
      const installations = { ...(current?.installations ?? {}) };
      delete installations[String(id)];
      return { installations };
    });
  }

  // --------------------------------------------------------------- pulls

  async putPull(pull) {
    await update(PULLS_FILE, (current) => ({
      pulls: { ...(current?.pulls ?? {}), [pull.id]: pull },
    }));
  }

  // Keyed by the record's own id, which is what `putPull` writes it under.
  // A caller that knows the id hands it over (pulls.js `idOf`, which
  // prefixes every host but GitHub); one that does not is asking about
  // GitHub, which is what the pair alone has always meant. The host comes
  // with it and is not needed here - the id already carries it - but the
  // dynamo backend's key is built from it, and the two signatures are one.
  async loadPull(repo, number, id = `${repo}#${number}`, host = null) {
    return (await readJson(PULLS_FILE))?.pulls?.[id] ?? null;
  }

  /** One repository's, one repo's, or everybody's since a moment; most recently updated first. */
  async loadPulls({ repo = null, repoId = null, host = null, since = 0, limit = 200 } = {}) {
    const pulls = Object.values((await readJson(PULLS_FILE))?.pulls ?? {});
    return pulls
      .filter((pull) => (repo ? pull.repo === repo : repoId ? pull.repoId === repoId : true))
      // A repository path means one thing per host, so a listing that named
      // one is asking about that host's records and not the other two's.
      .filter((pull) => !host || (pull.host ?? "github") === host)
      .filter((pull) => (pull.updatedAt ?? 0) >= since)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit);
  }

  // ----------------------------------------------------------- workflows

  async putWorkflowPipeline(pipeline) {
    await update(WORKFLOWS_FILE, (current) => ({
      ...(current ?? {}),
      pipelines: { ...(current?.pipelines ?? {}), [pipeline.id]: pipeline },
    }));
  }

  async loadWorkflowPipelines() {
    return Object.values((await readJson(WORKFLOWS_FILE))?.pipelines ?? {});
  }

  async deleteWorkflowPipeline(id) {
    await update(WORKFLOWS_FILE, (current) => {
      const pipelines = { ...(current?.pipelines ?? {}) };
      delete pipelines[id];
      return { ...(current ?? {}), pipelines };
    });
  }

  /** A run is `pipeline` + `id`; the newest WORKFLOW_RUNS_KEPT stay. */
  async putWorkflowRun(run) {
    await update(WORKFLOWS_FILE, (current) => {
      const runs = { ...(current?.runs ?? {}), [`${run.pipeline}#${run.id}`]: run };
      const keys = Object.keys(runs);
      if (keys.length > WORKFLOW_RUNS_KEPT) {
        keys.sort((a, b) => (runs[b].updatedAt ?? 0) - (runs[a].updatedAt ?? 0));
        for (const key of keys.slice(WORKFLOW_RUNS_KEPT)) delete runs[key];
      }
      return { ...(current ?? {}), runs };
    });
  }

  async loadWorkflowRun(pipeline, id) {
    return (await readJson(WORKFLOWS_FILE))?.runs?.[`${pipeline}#${id}`] ?? null;
  }

  /** One pipeline's runs, or everybody's since a moment; most recently updated first. */
  async loadWorkflowRuns({ pipeline = null, since = 0, limit = 500 } = {}) {
    const runs = Object.values((await readJson(WORKFLOWS_FILE))?.runs ?? {});
    return runs
      .filter((run) => (pipeline ? run.pipeline === pipeline : true))
      .filter((run) => (run.updatedAt ?? 0) >= since)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit);
  }

  async deleteWorkflowRun(pipeline, id) {
    await update(WORKFLOWS_FILE, (current) => {
      const runs = { ...(current?.runs ?? {}) };
      delete runs[`${pipeline}#${id}`];
      return { ...(current ?? {}), runs };
    });
  }

  // -------------------------------------------------------- machine time

}

/**
 * Read-modify-write one document, one write at a time.
 *
 * The queue is per file and per process. Two saves that overlapped would
 * otherwise both read the same "before", and the second would write away what
 * the first had just added.
 */
const writeQueues = new Map(); // file -> Promise

function update(file, change, options) {
  const pending = (writeQueues.get(file) ?? Promise.resolve())
    .catch(() => {}) // a failed write must not wedge every later one
    .then(async () => {
      const current = await readJson(file);
      await writeJson(file, change(current), options);
    });
  writeQueues.set(file, pending);
  return pending;
}

/** Replace an entry with the same id, or append it. */
function mergeById(entries, entry, key = "id") {
  const list = [...(entries ?? [])];
  const index = list.findIndex((existing) => existing[key] === entry[key]);
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  return list;
}

/**
 * A file that is not there is the first run; a file that is there and is not
 * JSON is a problem, and is thrown rather than read as "nothing". Reading it
 * as nothing is how a registry refresh that happened to land on a half-written
 * document deleted every repo from memory, and the next save wrote that
 * emptiness back for good.
 */
async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Written beside the file and renamed over it, so a reader never sees the
 * document truncated - `writeFile` empties the file before it fills it, and
 * anything reading in that window got an empty registry.
 */
async function writeJson(file, data, options = {}) {
  const staging = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(staging, JSON.stringify(data, null, 2), options);
    await fs.rename(staging, file);
    // writeFile applies `mode` only to a file it creates, and umask may have
    // taken bits off - re-assert it on the file that now stands.
    if (options.mode) await fs.chmod(file, options.mode);
  } catch {
    // Losing the write costs persistence, not the running session.
    await fs.rm(staging, { force: true }).catch(() => {});
  }
}
