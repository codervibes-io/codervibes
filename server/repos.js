// Repo registry: who owns what, who it's shared with, and what each
// member is allowed to do. Capabilities are enforced server-side in index.js -
// the UI only reflects what this module decides.
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { store } from "./store/index.js";
import { LIMITS, LimitError } from "./limits.js";
import { publish } from "./events.js";
import { whyNotAModel, DEFAULT_MODEL } from "./models.js";
// The model of a grant, not the connector catalogue behind it - see
// permissions-core.js. Whoever imports permissions.js registers the
// connector half with it, and these read it through the same functions.
import { normalize as normalizePermissions, fromCapabilities, everything, preset } from "./permissions-core.js";
import { askFirstOf, cleanAskFirst } from "./action-approvals.js";
import { countOpen as openPulls } from "./pulls.js";
import { hasRepository } from "./repo-sources/shape.js";
import { hasConnectors } from "./edition.js";
import { mergeChanges } from "./harness-changes.js";
import * as agents from "./agents.js";
import { workspaces } from "./workspaces.js";

/**
 * What a share grants is a list of permission ids - one per action, see
 * permissions.js for the catalogue, the groups and the presets. Owners
 * always hold everything.
 *
 * A record from before that file has `capabilities`, the six-key object
 * this used to be. It is read through `fromCapabilities` until the grant is
 * next edited, at which point `permissions` is written beside it and the
 * object stops mattering. Nothing in this file reads a capability by name.
 */

/** Sensible default for a new share: can look, can't touch. */
export const DEFAULT_SHARE = preset("reader", { agent: false });

/**
 * Agent members.
 *
 * A repo can be shared with a person by email, or with an *agent* — the
 * user's own Claude Code, Cursor, or anything else that speaks MCP. From the
 * product's point of view the two are the same thing: a member with a name, a
 * set of permissions, a place in the presence row, and edits that stream into
 * everybody's editor. The only real difference is how it authenticates. A
 * person proves who they are with an account; an agent presents a token.
 *
 * The token is the whole security boundary, so:
 *   - it is generated here, never chosen;
 *   - only its SHA-256 is stored, so the store cannot leak working tokens;
 *   - it is returned exactly once, at creation, and cannot be read back;
 *   - it is compared in constant time.
 */
const { TOKEN_PREFIX, hashToken, sameHash, isLegacy, memberOf } = agents;

/** A repo can have this many agents working in it. The records themselves are the owner's (agents.js). */
const MAX_AGENTS_PER_REPO = 10;

export class RepoRegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const isEmail = (email) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email);

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "repo"
  );
}

/**
 * A stored record with the lists every reader assumes.
 *
 * `create` writes them all, but a record can reach the store another way -
 * a test planting one, an older version of this app, a hand edit - and one
 * without a member list threw out of `permissionsFor`, which every session
 * calls for every repo: one such record and nobody could sign in. The
 * missing lists are made empty here, once, as the record comes in; nothing
 * about who owns it is invented.
 */
function withShape(repo) {
  repo.members ??= [];
  repo.agents ??= [];
  repo.tasks ??= [];
  return repo;
}

/**
 * How many tasks are in each state. Every state is present, at zero when
 * empty, so a reader never has to ask whether a missing key means none or
 * means an older server - see agent-tasks.js STATES for what they mean.
 */
export function countTasks(tasks) {
  const counts = { open: 0, accepted: 0, blocked: 0, done: 0, declined: 0, waiting: 0 };
  for (const task of tasks) {
    // A blocked task waiting on a person is counted as that, not as stuck:
    // the two ask different things of the reader (agent-tasks.js "Waiting
    // on a person").
    if (task.state === "blocked" && task.waitingOn) counts.waiting += 1;
    else if (task.state in counts) counts[task.state] += 1;
  }
  return counts;
}

/**
 * The permissions a stored grant holds - a member's or an agent's.
 *
 * `permissions` when the record has been written since permissions.js;
 * otherwise the old `capabilities` object, translated. Every reader of a
 * grant - the MCP tool list, the console's chips, the routes - goes through
 * this, so the two shapes never disagree about what somebody may do.
 */
export function permissionsOf(repo, entry, { agent = true, grants = true, now = Date.now() } = {}) {
  if (!entry) return [];
  const owner = repo?.owner ?? null;
  const held = Array.isArray(entry.permissions)
    ? [...entry.permissions]
    : normalizePermissions(fromCapabilities(entry.capabilities, { owner, agent }), { owner, agent });
  // Plus whatever the owner granted for a while (access-requests.js) that
  // has not run out. Folded in here, once, so the tool list, the checks and
  // the chips all see the same thing; left out (`grants: false`) for the
  // list the console edits, so saving that list never makes a timed grant
  // permanent.
  const live = grants ? activeGrantIds(entry, now) : [];
  if (!live.length) return held;
  return normalizePermissions([...held, ...live], { owner, agent });
}

/** The grants on a record that have not run out - `{id, until, by, requestId}` each. */
export function activeGrants(entry, now = Date.now()) {
  return (entry?.grants ?? [])
    .filter((grant) => grant?.id && Date.parse(grant.until) > now)
    .map((grant) => ({ id: grant.id, until: grant.until, by: grant.by ?? null, requestId: grant.requestId ?? null }));
}

const activeGrantIds = (entry, now) => activeGrants(entry, now).map((grant) => grant.id);

/** A grant somebody sent - a list, or for one release the old object. */
function grantFrom(input, { owner, agent }) {
  // A preset by name is the third shape, for a caller that means "the usual"
  // rather than a list - a resident started from a task, say.
  if (typeof input === "string") return preset(input, { owner, agent });
  const ids = Array.isArray(input)
    ? input
    : Array.isArray(input?.permissions)
      ? input.permissions
      : fromCapabilities(input?.capabilities ?? input, { owner, agent });
  return normalizePermissions(ids, { owner, agent });
}

class RepoRegistry {
  constructor() {
    this.repos = new Map();
    this.loaded = false;
    this.loading = null;
  }

  /**
   * Read the registry from the store, once.
   *
   * A second caller while the first read is still in flight waits for it
   * rather than returning at once: `loaded` used to be set before the scan
   * began, so the boot's orphan report - which loads and then asks what the
   * records claim - ran against an empty registry whenever the resident
   * lease restore had started the scan a moment earlier, and named every
   * live machine on the installation as unclaimed.
   */
  async load() {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.readAll().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  async readAll() {
    try {
      // A legacy grant reads as "whatever its owner has connected", which
      // needs the connector rows in memory - see permissions.fromCapabilities.
      // Asked for here rather than at the top of the file, and only by an
      // installation that has connectors at all: one without them has no
      // rows to load, and the local edition does not carry the module
      // (edition.js `hasConnectors`).
      if (hasConnectors()) {
        const { identities } = await import("./connectors/store.js");
        await identities.load();
      }
      // Every repo is in a workspace, and the ones from before are put in
      // one below - which needs the workspaces in memory first.
      await workspaces.load();
      for (const repo of await store.loadRepos()) {
        this.repos.set(repo.id, withShape(repo));
      }
    } catch (err) {
      // A store that cannot be reached is worth saying out loud - starting with
      // an empty registry would silently look like "no repos yet".
      throw new Error(`Could not load repos from ${store.name}: ${err.message}`);
    }
    this.loaded = true;
    this.warnIfOwnerless();
    await this.adoptAgents();
    await this.adoptWorkspaces();
  }

  /**
   * Put every repo from before workspaces in its owner's personal one.
   *
   * A repo is in exactly one workspace and everything the console shows is
   * shown per workspace, so a record without one would be visible nowhere.
   * The owner's personal workspace is the one place that changes nothing
   * about who can see it: the owner sees it, as before, and nobody else
   * does until they are invited. Written back at once, like the machine
   * records, so two processes cannot each decide differently.
   *
   * People the repo was shared with are not put in the workspace. That
   * would widen what they see from one repo to every repo of the owner's,
   * on a change whose point is narrowing. They keep their grant, and the
   * boot says who is left outside, so the owner knows to invite them.
   */
  async adoptWorkspaces() {
    for (const repo of this.repos.values()) {
      if (repo.workspace || !repo.owner) continue;
      let home;
      try {
        home = await workspaces.personalOf(repo.owner);
      } catch (err) {
        console.warn(`[repos] could not find a workspace for ${repo.id}: ${err.message}`);
        continue;
      }
      repo.workspace = home.id;
      try {
        await this.save(repo);
      } catch (err) {
        console.warn(`[repos] could not store the workspace of ${repo.id}: ${err.message}`);
      }
      for (const member of repo.members) {
        if (!workspaces.isMember(home, member.email)) {
          console.warn(
            `[repos] '${repo.id}' is shared with ${member.email}, who is not in its workspace ` +
              `'${home.name}' - they will not see it until ${repo.owner} invites them there.`,
          );
        }
      }
    }
  }

  /**
   * Re-read the registry from the store.
   *
   * `load()` runs once per process, but production runs more than one machine
   * behind the proxy. A repo created on one machine is invisible to the
   * other until it restarts - and `resolveSession` then quietly falls back to
   * a different repo, which reads as "opening a repo is broken".
   * Callers hit this only when they ask for an id we do not recognise.
   */
  async refresh() {
    let fresh;
    try {
      fresh = await store.loadRepos();
    } catch (err) {
      // A transient store error must not empty a working registry - but the
      // caller is now answering from a cache of unknown age, and silence made
      // that indistinguishable from a fresh read. Reported, so a listing that
      // claims to be complete can say when it is not.
      return { ok: false, error: err.message };
    }

    const seen = new Set();
    const behind = [];
    for (const repo of fresh) {
      seen.add(repo.id);
      // A re-read never takes the registry backwards. The scan is slow and
      // the record may have been saved here while it ran - a task sent, a
      // grant changed - and the copy it brings is from before. Merging that over
      // memory undid the save: the task was in the store and gone from the
      // Map, and the next routine write of the record (an agent's lastSeenAt)
      // put the task-less copy back over the store. Tasks were "often lost".
      // The record's revision says which copy is newer: ours, unless another
      // process wrote after we did.
      const held = this.repos.get(repo.id);
      if (held && (held.rev ?? 0) > (repo.rev ?? 0)) {
        behind.push(held);
        continue;
      }
      // Merge, so process-local bookkeeping survives.
      this.repos.set(repo.id, withShape({ ...held, ...repo }));
    }
    // A store behind memory stays behind until something else saves the
    // record - which for a quiet repo is never, and a restart would
    // then load the older copy. Written back now, so what memory knows is
    // what the store holds. Not fatal if it cannot be: memory is still right.
    for (const repo of behind) {
      try {
        await this.save(repo);
      } catch (err) {
        console.warn(`[repos] could not bring the store up to date for ${repo.id}: ${err.message}`);
      }
    }
    // Deletions on another machine should propagate too.
    for (const id of [...this.repos.keys()]) {
      if (!seen.has(id)) this.repos.delete(id);
    }
    this.warnIfOwnerless();
    await this.adoptAgents();
    await this.adoptWorkspaces();
    return { ok: true, error: null };
  }

  /**
   * Persist one repo. The JSON backend rewrites its whole document and
   * needs the full set; DynamoDB writes the single item and ignores it.
   *
   * A repo the registry no longer has is not written. Preparing a
   * sandbox is slow and saves when it finishes - seeding done - and if the repo was deleted while that was in flight, the
   * save would put the record straight back: a repo that reappears after
   * you delete it, pointing at a sandbox that no longer exists.
   */
  async save(repo) {
    if (repo && !this.repos.has(repo.id)) return;
    const all = [...this.repos.values()];
    // Counted up on every write, so a copy read back can be told from the
    // one in memory - see `refresh`. Records from before this have none,
    // which reads as zero: older than anything saved since.
    const stamp = (entry) => {
      entry.rev = (entry.rev ?? 0) + 1;
    };
    if (repo) {
      stamp(repo);
      await store.putRepo(repo, all);
    } else {
      for (const entry of all) {
        stamp(entry);
        await store.putRepo(entry, all);
      }
    }
    // Every change to a repo - an agent added, a task moved, a machine
    // attached, a member invited - comes through here, so this is where an
    // open console hears about it. After the write: a page that re-reads on
    // the nudge must find the new record, not the old one.
    if (repo) publish("repo.saved", { repoId: repo.id });
    else publish("registry.saved");
  }

  async forget(id) {
    await store.deleteRepo(id, [...this.repos.values()]);
    // The repo is gone from the map by now, so nobody "can access" it;
    // everybody hears, and a page that never showed it redraws the same.
    publish("repo.forgotten");
  }

  get(id) {
    const repo = this.repos.get(id);
    if (!repo) {
      throw new RepoRegistryError(`No repo '${id}'`, 404);
    }
    return repo;
  }

  /**
   * Every repo this person may open.
   *
   * `canAccess`, not "is named somewhere on the record". Being a member and
   * being able to do anything came apart: this used to include a repo on
   * membership alone, while `canAccess` - which the machines page and
   * `readableRepo` ask - wants at least one permission. Somebody
   * shared in with nothing granted got the repo in their rail and a 403
   * from everything in it, including the listing of its own machines.
   *
   * `share` refuses to mint one of those now, so this is for the records that
   * already exist. They are left where they are rather than repaired on the
   * way past: a grant that gives nothing reaches nobody, which is what it
   * already meant everywhere except here.
   */
  listFor(email, { workspace = null } = {}) {
    const user = normalizeEmail(email);
    return [...this.repos.values()]
      .filter((repo) => this.canAccess(repo, user))
      .filter((repo) => workspace == null || repo.workspace === workspace)
      .map((repo) => this.describe(repo, user))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The repos one person can reach, as the registry holds them - for the
   * MCP endpoint, which needs the record and not the description, when the
   * person's own setup connects on their ingest token (mcp.js). `fresh`
   * re-reads the store first, for the same reason `findAllByToken` does:
   * a repo shared on another machine is one this process has never seen.
   */
  async accessibleTo(email, { fresh = false } = {}) {
    await this.load();
    if (fresh) await this.refresh();
    const user = normalizeEmail(email);
    return [...this.repos.values()]
      .filter((repo) => this.canAccess(repo, user))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Whether any repo is in this workspace - what stops it being deleted. */
  holds(workspaceId) {
    for (const repo of this.repos.values()) {
      if (repo.workspace === workspaceId) return true;
    }
    return false;
  }

  /** Whether this repo is in this workspace. A repo not yet adopted is in nobody's. */
  inWorkspace(repo, workspaceId) {
    return Boolean(repo?.workspace) && repo.workspace === workspaceId;
  }

  /**
   * The repos made from one repository - `owner/name`, case aside. A
   * person's own setup names its checkout by the remote, not by a repo
   * id, and this is what that name is looked up by. Two repos of one
   * repository in two workspaces are both it: the work of a checkout is
   * the work of every workspace holding that repository.
   */
  /**
   * The repos of one repository, on one host.
   *
   * The host as well as the path, because two hosts can spell a repository
   * the same way: a session on `ada/engine` at GitLab is not the work of a
   * repo connected to `ada/engine` at GitHub, and joining them would put
   * one team's sessions on another's page. A repo record here is a GitHub
   * one by construction (`source.kind`), so anything but GitHub matches
   * nothing - which is the right answer rather than a missing case.
   */
  ofRepository(fullName, host = "github") {
    const wanted = String(fullName ?? "").trim().toLowerCase();
    if (!wanted || (host ?? "github") !== "github") return [];
    return [...this.repos.values()].filter(
      (repo) => repo.source?.kind === "github" && String(repo.source.repo ?? "").toLowerCase() === wanted,
    );
  }

  /**
   * The repo a person's checkout of a repository lands in: the one of it
   * they own, else the first of it they can open, else none - a checkout
   * of a repository nobody connected here is no repo's work.
   */
  checkoutFor(fullName, email, host = "github") {
    const user = normalizeEmail(email);
    const reachable = this.ofRepository(fullName, host).filter((repo) => this.canAccess(repo, user));
    return reachable.find((repo) => repo.owner === user) ?? reachable[0] ?? null;
  }

  describe(repo, email) {
    const user = normalizeEmail(email);
    return {
      id: repo.id,
      name: repo.name,
      description: repo.description ?? "",
      source: repo.source ?? null,
      // A repo from before repositories were the point: its files live
      // on its machine and nowhere else. The console says so, and offers to
      // make a repository from them (index.js /export). See hasRepository in
      // repository.js for what counts.
      legacy: !hasRepository(repo),
      // Pull requests open from this repo's work, for the card. From
      // memory: a card cannot wait on the store, and a count that is a
      // restart behind says "0" rather than nothing (pulls.js warm).
      openPulls: openPulls(repo),
      owner: repo.owner,
      isOwner: repo.owner === user,
      // Which workspace it is in - the one place it shows (workspaces.js).
      workspace: repo.workspace ?? null,
      createdAt: repo.createdAt,
      permissions: this.permissionsFor(repo, user),
      members: repo.members.map((member) => ({
        email: member.email,
        permissions: permissionsOf(repo, member, { agent: false }),
        invitedAt: member.invitedAt,
        invitedBy: member.invitedBy,
      })),
      // The records behind the memberships (agents.js). Never the token,
      // or its hash, or a resident's epoch: this object goes to the browser.
      agents: this.agentsIn(repo).map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind ?? (agent.resident ? "resident" : "invited"),
        // The list the owner edits; what the owner granted for a while sits
        // apart, so it reads as "until 15:00" and is never saved back as
        // forever (access-requests.js).
        permissions: permissionsOf(repo, agent, { grants: false }),
        grants: activeGrants(agent),
        // Which of those the owner approves call by call (action-approvals.js).
        askFirst: askFirstOf(agent),
        createdAt: agent.createdAt,
        createdBy: agent.createdBy ?? null,
        lastSeenAt: agent.lastSeenAt ?? null,
        // Where it lives, for the ones that live somewhere - see addResident.
        // The epoch stays behind: it is half of a credential.
        resident: agent.resident
          ? {
              sandboxId: agent.resident.sandboxId,
              startedAt: agent.resident.startedAt,
              startedBy: agent.resident.startedBy,
              model: agent.resident.model ?? null,
              // Which engine its process was declared with - see claude-code.js.
              engine: agent.resident.engine ?? null,
              // Which harness it was declared in (harnesses.js), and which
              // its owner picked for it - the two differ until its next
              // start.
              harness: agent.resident.harness ?? null,
              harnessId: agent.resident.harnessId ?? null,
            }
          : null,
      })),
      // How much work is queued here, by state - enough for a list row or a
      // tab label to say "3 waiting, 1 stuck" without fetching the tasks
      // themselves. The tasks are on /api/repos/:id/tasks.
      tasks: countTasks(repo.tasks ?? []),
    };
  }

  /**
   * What `email` may do in `repo`.
   *
   * A repo with no owner grants nothing, to anybody. It used to grant
   * everything to everybody - the single-repo install left one ownerless
   * for the first person to sign in to claim - and with that install gone,
   * "no owner" stopped being a state anything creates. `create` refuses
   * without an owner, so this is an invariant rather than a case: it is here
   * so that a record which somehow broke it reaches nobody instead of
   * everybody. `warnIfOwnerless` is how you find out one exists.
   *
   * Somebody in the repo's workspace with no grant of their own holds the
   * default share. That is what being in a workspace means (workspaces.js):
   * the room's repos are in view, and the owner grants more per repo, per
   * person, as before. A grant on the repo replaces the default rather than
   * adding to it, so an owner who narrows somebody gets what they asked for.
   *
   * The default share is now *empty*, and that is not a bug. Reading a repo
   * used to be a grant - `read_file`, over files on a machine of ours - and
   * there are no such files: what is left to grant is what somebody may do
   * to things outside the repo. So "may look" and "may do" have come apart,
   * and `canAccess` is the one that answers looking.
   */
  permissionsFor(repo, email) {
    const user = normalizeEmail(email);
    if (!user) return [];
    if (repo.owner === user) return everything({ owner: repo.owner, agent: false });
    const member = repo.members.find((entry) => entry.email === user);
    if (member) return permissionsOf(repo, member, { agent: false });
    // An ownerless record reaches nobody through its workspace either: the
    // workspace was the owner's, and a repo with no owner is half-written.
    if (repo.owner && repo.workspace && workspaces.isMember(workspaces.find(repo.workspace), user)) {
      return [...DEFAULT_SHARE];
    }
    return [];
  }

  /** May `email` do `id` here? Owners may do everything. */
  permits(repo, email, id) {
    return id == null || this.permissionsFor(repo, email).includes(id);
  }

  /**
   * May `email` see this repo at all?
   *
   * Membership, not permissions. This used to ask whether they held at least
   * one grant, which worked while reading was itself a grant; now that
   * reading a repo is not a thing this app does, a workspace member with
   * nothing ticked holds no permissions and must still be able to open the
   * room they are in. Being the owner, a member of the repo, or a member of
   * its workspace is what "can see it" means.
   */
  canAccess(repo, email) {
    const user = normalizeEmail(email);
    if (!repo?.owner) return false;
    // A repo in the demo workspace is readable by anybody, including
    // somebody with no account at all - that is the one room a visitor is
    // let into, and workspaces.js `canSee` is what says so. Asked before the
    // `user` guard below, because for a visitor there is no user to ask
    // about. It stays a *looking* right: `permissionsFor` gives a caller
    // with no address nothing, and gives a signed-in one nothing here
    // either, because the demo's members are the made-up people in it.
    if (repo.workspace && workspaces.isDemo(workspaces.find(repo.workspace))) return true;
    if (!user) return false;
    if (repo.owner === user) return true;
    if (repo.members.some((entry) => entry.email === user)) return true;
    return Boolean(repo.workspace && workspaces.isMember(workspaces.find(repo.workspace), user));
  }

  /**
   * Whether this repo belongs to the shared demo.
   *
   * Readable by everybody (`canAccess`) and therefore reachable by
   * everybody's setup token, which is exactly why it has to be asked about
   * separately: reachable is not the same as somewhere a person's own work
   * may be filed, and the two were the same question until a real session
   * landed in the demo and went out on a public page.
   */
  isDemo(repo) {
    return Boolean(repo?.workspace && workspaces.isDemo(workspaces.find(repo.workspace)));
  }

  requireOwner(repo, email) {
    const user = normalizeEmail(email);
    if (repo.owner !== user) {
      throw new RepoRegistryError(
        "Only the owner can change sharing or delete this repo",
        403,
      );
    }
  }

  // ----------------------------------------------------------- mutations

  /** How many repos this person owns. Shares don't count against them. */
  countOwnedBy(email) {
    const user = normalizeEmail(email);
    let count = 0;
    for (const repo of this.repos.values()) {
      if (repo.owner === user) count++;
    }
    return count;
  }

  /**
   * A repo record, empty. Its files come from whatever the caller does
   * next - an import from a repository (index.js createFromRepo), a copy of
   * another repo - and its `source` is set when they have.
   */
  async create(name, ownerEmail, { workspace = null } = {}) {
    const owner = normalizeEmail(ownerEmail);
    if (!owner) throw new RepoRegistryError("Sign in before creating a repo", 401);
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw new RepoRegistryError("A repo needs a name");
    // Into the workspace the caller has open, which they must be in; into
    // their personal one when nothing says. Resolved before the quota
    // checks so a bad workspace is refused as that, not as "at the limit".
    const home = await this.workspaceFor(workspace, owner);

    // Every other machine's repos count towards the quotas, and their ids
    // are in the same namespace as ours - so start from the shared truth
    // rather than from whatever this process happens to remember.
    await this.refresh();

    if (this.countOwnedBy(owner) >= LIMITS.maxReposPerUser) {
      throw new LimitError(
        `You already have ${LIMITS.maxReposPerUser} repos, which is the ` +
          `limit. Delete one to make room.`,
        { status: 403, limit: LIMITS.maxReposPerUser },
      );
    }
    if (this.repos.size >= LIMITS.maxReposTotal) {
      throw new LimitError(
        "CoderVibes is at its repo limit. Try again later.",
        { status: 503, limit: LIMITS.maxReposTotal },
      );
    }

    // Ids are global - they name the sandbox VM (`cv-<id>`). A plain slug means two people who both make a "scraper" race
    // for one id, and the loser's Put silently takes over the winner's
    // repo *and* their sandbox. The random suffix makes that impossible,
    // and also stops a new repo from inheriting the sandbox of a deleted
    // one that happened to have the same name.
    const base = slugify(trimmed);
    let id = `${base}-${randomBytes(3).toString("hex")}`;
    while (this.repos.has(id)) id = `${base}-${randomBytes(3).toString("hex")}`;

    // No directory. A repo used to be a checkout on a machine this app
    // booted, and `dir` was where the local provider kept it; it boots no
    // machines, and a repo is now a GitHub repository it watches. The files
    // are on GitHub and on whatever machine the person is working on.

    const repo = {
      id,
      name: trimmed,
      description: "",
      source: null,
      owner,
      workspace: home.id,
      createdAt: new Date().toISOString(),
      members: [],
    };
    this.repos.set(id, repo);
    await this.save(repo);
    return this.describe(repo, owner);
  }

  /**
   * The workspace a repo of this person's goes in: the one asked for, if
   * they are in it, else their personal one.
   */
  async workspaceFor(workspaceId, email) {
    const user = normalizeEmail(email);
    if (workspaceId == null || workspaceId === "") return workspaces.personalOf(user);
    let home = workspaces.find(workspaceId);
    if (!home) {
      // Made on the other machine a moment ago, perhaps.
      await workspaces.refresh();
      home = workspaces.find(workspaceId);
    }
    if (!home) throw new RepoRegistryError(`No workspace '${workspaceId}'`, 404);
    if (!workspaces.isMember(home, user)) throw new RepoRegistryError("You are not in that workspace", 403);
    return home;
  }

  /**
   * Put a repo in another workspace. The owner's call, and only into a
   * workspace they are in. Its members keep their grants but see it only
   * if they are in the new workspace too - the same rule as `share`.
   */
  async move(id, workspaceId, email) {
    const repo = this.get(id);
    this.requireOwner(repo, email);
    const home = await this.workspaceFor(workspaceId, email);
    if (repo.workspace !== home.id) {
      repo.workspace = home.id;
      await this.save(repo);
    }
    return this.describe(repo, email);
  }

  /**
   * Somebody left a workspace: their repos in it go home with them, to
   * their personal one. A repo whose owner cannot see it - it is in a room
   * they are no longer in - is a repo they cannot delete, share or turn off,
   * and the others were only ever readers of it.
   */
  async evacuate(workspaceId, email) {
    const user = normalizeEmail(email);
    const moved = [];
    for (const repo of this.repos.values()) {
      if (repo.owner !== user || repo.workspace !== workspaceId) continue;
      const home = await workspaces.personalOf(user);
      repo.workspace = home.id;
      await this.save(repo);
      moved.push(repo.id);
    }
    return moved;
  }

  /**
   * Say so if a repo belongs to nobody, which should never happen.
   *
   * `create` refuses without an owner, so every repo has one. This is
   * not a case to handle, it is an invariant - and the only thing worth doing
   * about a broken one is making it findable. Everything above already treats
   * an ownerless record as reaching nobody, so it is inert rather than
   * dangerous; what it is not is *visible*, and somebody whose repo has
   * gone quiet deserves better than an empty list and no explanation.
   *
   * Deliberately does not delete it. A record that lost a field is a bug to
   * fix with the record in front of you, and deleting somebody's repo on
   * the way past cannot be undone.
   */
  warnIfOwnerless() {
    for (const repo of this.repos.values()) {
      if (repo.owner) continue;
      console.warn(
        `repo '${repo.id}' has no owner, which should not be ` +
          `possible - nobody can see or open it. Left where it is; fix the ` +
          `record rather than letting it be deleted on the way past.`,
      );
    }
  }

  async rename(id, name, email) {
    const repo = this.get(id);
    this.requireOwner(repo, email);
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw new RepoRegistryError("A repo needs a name");
    repo.name = trimmed;
    await this.save(repo);
    return this.describe(repo, email);
  }

  async setDescription(id, description, email) {
    const repo = this.get(id);
    this.requireOwner(repo, email);
    repo.description = String(description ?? "").trim().slice(0, 600);
    repo.descriptionEditedByUser = true;
    await this.save(repo);
    return this.describe(repo, email);
  }

  /**
   * Record what a repo was built from. Called when a question is
   * generated into it, so the card says where the problem came from.
   * An owner-written description is left alone.
   */
  async setSource(id, source, { description } = {}) {
    const repo = this.repos.get(id);
    if (!repo) return null;
    repo.source = source;
    if (description && !repo.descriptionEditedByUser) {
      repo.description = String(description).trim().slice(0, 600);
    }
    await this.save(repo);
    return repo;
  }

  async remove(id, email) {
    const repo = this.get(id);
    this.requireOwner(repo, email);
    if (this.repos.size === 1) {
      throw new RepoRegistryError("You need at least one repo", 400);
    }
    await this.discard(repo);
  }

  /**
   * One repo out of the registry and the store.
   *
   * No permission check and no "you need at least one" guard: both belong to
   * the caller. remove() makes them; the account reset deliberately does not,
   * because leaving somebody owning nothing is exactly what turns their next
   * sign-in back into a signup.
   */
  async discard(repo) {
    this.repos.delete(repo.id);
    await this.forget(repo.id);
  }

  /**
   * Everything this person owns, gone.
   *
   * Repos other people shared with them are left alone - those are not
   * theirs to delete.
   *
   * @returns {Promise<Array<{id: string, name: string}>>} what was removed
   */
  async removeAllOwnedBy(email) {
    const owner = normalizeEmail(email);
    if (!owner) return [];
    // Another machine's copy of this person's repos is still this
    // person's, and a reset that leaves half of them behind is worse than one
    // that refuses.
    await this.refresh();
    const removed = [];
    for (const repo of [...this.repos.values()]) {
      if (repo.owner !== owner) continue;
      await this.discard(repo);
      removed.push({ id: repo.id, name: repo.name });
    }
    return removed;
  }

  async share(id, email, permissions, invitedByEmail) {
    const repo = this.get(id);
    this.requireOwner(repo, invitedByEmail);

    const member = normalizeEmail(email);
    if (!isEmail(member)) {
      throw new RepoRegistryError(`'${email}' is not a valid email address`);
    }
    if (member === repo.owner) {
      throw new RepoRegistryError("That's the owner - they already have full access");
    }
    // Seeing a repo is the workspace's to decide; a share only says what
    // somebody in the room may do in it. A grant to somebody outside would
    // be a grant to a repo they cannot find, so the invitation to the
    // workspace comes first - and that one any member can send.
    const room = repo.workspace ? workspaces.find(repo.workspace) : null;
    if (room && !workspaces.isMember(room, member)) {
      throw new RepoRegistryError(
        `${member} is not in the '${room.name}' workspace. Invite them to the workspace first; ` +
          `then a share here says what more they may do than look.`,
      );
    }

    // A share that grants nothing is not a share. It reads as one - their
    // address is on the repo, they are in the members list, the owner
    // believes they have been let in - and every door in the place answers
    // them with a 403. Refused here rather than stored, because the record
    // that results is indistinguishable from a share somebody has revoked
    // without saying so.
    const granted = grantFrom(permissions, { owner: repo.owner, agent: false });
    if (!granted.length) {
      throw new RepoRegistryError(
        "Choose at least one thing they may do - a share that grants nothing " +
          "puts them on the repo and lets them open none of it.",
      );
    }

    const entry = {
      email: member,
      permissions: granted,
      invitedAt: new Date().toISOString(),
      invitedBy: normalizeEmail(invitedByEmail),
    };
    const existing = repo.members.findIndex((m) => m.email === member);
    if (existing >= 0) {
      repo.members[existing] = entry;
    } else {
      if (repo.members.length >= LIMITS.maxMembersPerRepo) {
        throw new LimitError(
          `A repo can be shared with at most ${LIMITS.maxMembersPerRepo} people.`,
          { status: 403, limit: LIMITS.maxMembersPerRepo },
        );
      }
      repo.members.push(entry);
    }

    await this.save(repo);
    return this.describe(repo, invitedByEmail);
  }

  // --------------------------------------------------------------- agents
  //
  // The record is the owner's (agents.js); a repo holds *membership* -
  // `repo.agents[]` says which agents may work here, when each was let in
  // and by whom, and nothing else. An entry from before that is the record
  // itself (`isLegacy`), and is read as one until `adoptAgents` moves it to
  // the owner's row - so a fixture planted in memory, a store written by an
  // older process and this process's own writes all read the same way.

  /** The record behind an entry of `repo.agents[]`: the entry itself when it is old-shape, else the owner's. */
  recordOf(repo, entry) {
    if (!entry) return null;
    if (isLegacy(entry)) return entry;
    return agents.get(repo?.owner, entry.id);
  }

  /** The record of one agent that is a member here, or null. */
  agentIn(repo, agentId) {
    const wanted = String(agentId ?? "");
    const entry = (repo?.agents ?? []).find((item) => item.id === wanted);
    return entry ? this.recordOf(repo, entry) : null;
  }

  /** The records of every agent that is a member here. An entry whose record is gone lists nothing. */
  agentsIn(repo) {
    const out = [];
    for (const entry of repo?.agents ?? []) {
      const record = this.recordOf(repo, entry);
      if (record) out.push(record);
    }
    return out;
  }

  /** Whether an agent is a member here. */
  hasAgent(repo, agentId) {
    const wanted = String(agentId ?? "");
    return (repo?.agents ?? []).some((item) => item.id === wanted);
  }

  /**
   * Change a record wherever it lives: on the repo, for one still in the
   * old shape, else on the owner's row. `mutate` says whether it changed
   * anything; a note with nothing to note writes nothing. `quiet` swallows
   * a store that refuses - a timestamp is not worth failing a request over.
   */
  async writeAgent(repo, agentId, mutate, { quiet = false } = {}) {
    const wanted = String(agentId ?? "");
    const entry = (repo?.agents ?? []).find((item) => item.id === wanted);
    if (!entry) return null;
    if (isLegacy(entry)) {
      const changed = mutate(entry);
      if (changed !== false) {
        if (quiet) await this.save(repo).catch(() => {});
        else await this.save(repo);
      }
      return entry;
    }
    const write = agents.update(repo.owner, wanted, mutate);
    return quiet ? write.catch(() => null) : write;
  }

  /** The room checks a repo makes before letting an agent in. */
  requireRoom(repo, name) {
    repo.agents ??= [];
    const trimmed = String(name ?? "").trim();
    if (trimmed && this.agentsIn(repo).some((agent) => agent.name === trimmed)) {
      throw new RepoRegistryError(`This repo already has an agent called '${trimmed}'`);
    }
    if (repo.agents.length >= MAX_AGENTS_PER_REPO) {
      throw new LimitError(`A repo can hold at most ${MAX_AGENTS_PER_REPO} agents.`, { status: 403, limit: MAX_AGENTS_PER_REPO });
    }
  }

  /**
   * Invite an agent. Returns the repo *and* the token, which is the only
   * time the token exists anywhere outside the caller's hands. The record
   * is the owner's; this repo is the first it is a member of.
   */
  async addAgent(id, name, permissions, invitedByEmail) {
    const repo = this.get(id);
    this.requireOwner(repo, invitedByEmail);
    this.requireRoom(repo, name);
    const { agent, token } = await agents.add(repo.owner, {
      name,
      permissions: grantFrom(permissions, { owner: repo.owner, agent: true }),
      invitedBy: invitedByEmail,
    });
    repo.agents.push(memberOf(agent, { createdBy: normalizeEmail(invitedByEmail) }));
    await this.save(repo);
    // The record itself, not just the repo it landed in: the caller may not
    // know what it is called - a name is optional now, and one nobody gave
    // is made up in here - so finding it again by the name that was sent is
    // a lookup that misses.
    return { repo: this.describe(repo, invitedByEmail), agent: { id: agent.id, name: agent.name }, token };
  }

  /**
   * An agent that lives in one of this repo's sandboxes.
   *
   * A member like any other - it has a name and permissions, it is in the
   * presence row, tasks can be sent to it - with a home: the sandbox it
   * lives in, which it is the master of (resident.js `guard`). It has no
   * token; its credential is signed per start from the epoch on the record
   * and stops resolving the moment the record goes.
   *
   * `startedBy` is whoever asked - `{email}` for a person, `{id, name}` for
   * an agent - and is recorded so the right to stop it can be checked later.
   * `dormant` seats it without marking it started: the signup team is
   * seated before anybody has a machine to start it on.
   */
  async addResident(id, { name, permissions, sandboxId, startedBy, origin = null, model = null, dormant = false }) {
    const repo = this.get(id);
    this.requireRoom(repo, name);
    if (this.residentOf(repo, sandboxId)) {
      throw new RepoRegistryError(`Sandbox '${sandboxId}' already has an agent living in it`);
    }
    const record = await agents.addResident(repo.owner, {
      name,
      permissions: grantFrom(permissions, { owner: repo.owner, agent: true }),
      repoId: repo.id,
      sandboxId,
      startedBy,
      origin,
      model,
      dormant,
    });
    repo.agents.push(memberOf(record, { createdBy: record.createdBy }));
    await this.save(repo);
    return record;
  }

  /** Forget a resident agent. Its credential stops verifying with the record. */
  async dropResident(id, agentId) {
    const repo = this.get(id);
    const wanted = String(agentId);
    const record = this.agentIn(repo, wanted);
    if (!record?.resident) return repo;
    const entry = repo.agents.find((item) => item.id === wanted);
    repo.agents = repo.agents.filter((item) => item !== entry);
    if (!isLegacy(entry)) await agents.remove(repo.owner, wanted).catch(() => null);
    await this.save(repo);
    return repo;
  }

  /** The agent living in this sandbox, or null. */
  residentOf(repo, sandboxId) {
    const wanted = String(sandboxId);
    return this.agentsIn(repo).find((agent) => agent.resident && agent.resident.sandboxId === wanted) ?? null;
  }

  /** Every agent living in one of this repo's sandboxes. */
  residentsOf(repo) {
    return this.agentsIn(repo).filter((agent) => agent.resident);
  }

  /**
   * A resident agent by its credential's claims - the repo, the agent id
   * and the epoch the credential was minted under. Null when any is wrong,
   * which is what revocation looks like: stopping the agent drops the
   * record, and every credential it was ever given stops resolving at once.
   */
  residentByEpoch(repoId, agentId, epoch) {
    const repo = this.repos.get(repoId);
    const agent = this.agentIn(repo, agentId);
    if (!agent?.resident || !epoch) return null;
    if (agent.resident.repoId && agent.resident.repoId !== String(repoId)) return null;
    if (!sameHash(agent.resident.epoch, String(epoch))) return null;
    return { repo, agent };
  }

  /**
   * Let an agent you already have into another repo.
   *
   * The same record - same id, same token, same grant - a member here too.
   * Which repos an agent reaches is explicit on purpose: the alternative,
   * one token reaching everything its owner owns, is one leaked credential
   * away from a much worse afternoon. You admit it a repo at a time, and
   * the memberships are what it can then switch between (`switch_repo`).
   *
   * `permissions`, when given, is the agent's one grant from now on - it
   * applies here and everywhere else it works, since the grant is the
   * record's rather than the copy's.
   */
  async grantAgent(id, agentId, permissions, requestedBy) {
    const repo = this.get(id);
    this.requireOwner(repo, requestedBy);

    const existing = this.findAgent(agentId, requestedBy);
    if (!existing) {
      throw new RepoRegistryError("No agent of yours has that id. You can only add agents you already own.", 404);
    }
    // Its credential is bound to the sandbox it lives in, in a repo it
    // lives in. There is no token to carry across, and there should not be.
    if (existing.agent.resident) {
      throw new RepoRegistryError(
        `'${existing.agent.name}' lives in a sandbox of '${existing.repo?.name ?? "another repo"}' ` +
          `and works there. Start another agent in this repo instead.`,
      );
    }
    if (this.hasAgent(repo, existing.agent.id)) {
      throw new RepoRegistryError(`'${existing.agent.name}' is already in this repo`);
    }
    this.requireRoom(repo, existing.agent.name);

    repo.agents.push(memberOf(existing.agent, { createdBy: normalizeEmail(requestedBy) }));
    await this.save(repo);
    // Widened, never narrowed: what is asked for here is added to the one
    // grant. A narrower list on the way into a second repo must not quietly
    // take away what it may do in the first - `updateAgent` is the verb for
    // that, and it says so.
    if (permissions != null) {
      const asked = grantFrom(permissions, { owner: repo.owner, agent: true });
      await this.writeAgent(repo, existing.agent.id, (record) => {
        const held = new Set(record.permissions ?? []);
        const missing = asked.filter((id) => !held.has(id));
        if (!missing.length) return false;
        record.permissions = normalizePermissions([...held, ...missing], { owner: repo.owner, agent: true });
      });
    }
    return this.describe(repo, requestedBy);
  }

  /**
   * One agent of this person's, with the repo it is found in: a resident's
   * home, else the first repo it is a member of, else - for one invited and
   * not yet let in anywhere - no repo at all.
   */
  findAgent(agentId, email) {
    const user = normalizeEmail(email);
    const wanted = String(agentId);
    const record = agents.get(user, wanted);
    if (record) {
      if (record.resident?.repoId) {
        const home = this.repos.get(record.resident.repoId);
        if (home && this.hasAgent(home, wanted)) return { repo: home, agent: record };
      }
      for (const repo of this.repos.values()) {
        if (repo.owner === user && this.hasAgent(repo, wanted)) return { repo, agent: record };
      }
      return { repo: null, agent: record };
    }
    // Still in the old shape, on a repo.
    for (const repo of this.repos.values()) {
      if (repo.owner && repo.owner !== user) continue;
      const entry = (repo.agents ?? []).find((item) => item.id === wanted);
      if (entry && isLegacy(entry)) return { repo, agent: entry };
    }
    return null;
  }

  /**
   * Every agent this person has, once each, and which of their repos it
   * is in. What the Executors page and the "add one you already have"
   * picker are built from.
   */
  agentsOwnedBy(email) {
    const user = normalizeEmail(email);
    const byId = new Map();
    const place = (record, repo) => {
      let entry = byId.get(record.id);
      if (!entry) {
        const homeId = record.resident?.repoId ?? repo?.id ?? null;
        const home = homeId ? this.repos.get(homeId) : null;
        const box = home ? (home.sandboxes ?? []).find((item) => item.id === record.resident?.sandboxId) : null;
        entry = {
          id: record.id,
          name: record.name,
          kind: record.kind ?? (record.resident ? "resident" : "invited"),
          // The list the owner edits; what was granted for a while sits
          // apart (access-requests.js), so it is never saved back as forever.
          permissions: permissionsOf(home ?? repo, record, { grants: false }),
          grants: activeGrants(record),
          askFirst: askFirstOf(record),
          createdAt: record.createdAt,
          createdBy: record.createdBy ?? null,
          lastSeenAt: record.lastSeenAt ?? null,
          repos: [],
          // Where it lives, if it lives somewhere. Read by list_agents, so an
          // agent choosing who to hand work to knows this one has a machine of
          // its own - and by the master rule, so nobody else touches it.
          resident: record.resident
            ? {
                repoId: homeId,
                repoName: home?.name ?? null,
                sandboxId: record.resident.sandboxId,
                // By name too, because the console says "lives in lab" and
                // nobody knows their sandboxes by id.
                sandboxName: box?.name ?? record.resident.sandboxId,
                startedAt: record.resident.startedAt ?? null,
                // How long its machine stays up after its last activity, if
                // the machine has its own setting - the agent's page offers
                // to change it, since "it went to sleep" is read there.
                sleepAfterMs: box?.sleepAfterMs ?? null,
                // What it thinks with. Null when nobody chose and the loop
                // has not yet said - the console shows the default then.
                model: record.resident.model ?? null,
              }
            : null,
        };
        byId.set(record.id, entry);
      }
      if (repo && !entry.repos.some((item) => item.id === repo.id)) {
        // The grant is the record's, so it reads the same in every repo -
        // and so does what was granted for a while.
        entry.repos.push({ id: repo.id, name: repo.name, permissions: entry.permissions, grants: entry.grants });
      }
      if (record.lastSeenAt && (!entry.lastSeenAt || record.lastSeenAt > entry.lastSeenAt)) entry.lastSeenAt = record.lastSeenAt;
    };
    for (const record of agents.cached(user)) place(record, null);
    for (const repo of this.repos.values()) {
      if (repo.owner && repo.owner !== user) continue;
      for (const entry of repo.agents ?? []) {
        const record = this.recordOf(repo, entry);
        if (record) place(record, repo);
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Change what an agent may do, or what a resident thinks with or runs in.
   *
   * The grant is the record's, so changing it here changes it everywhere
   * the agent works. Takes effect on the agent's next call: permissions are
   * re-read on every request rather than captured at connect, which is what
   * makes revoking a permission mean now rather than eventually.
   */
  async updateAgent(id, agentId, { permissions, model, harnessId, askFirst }, requestedBy) {
    const repo = this.get(id);
    this.requireOwner(repo, requestedBy);
    const agent = this.agentIn(repo, agentId);
    if (!agent) throw new RepoRegistryError("No agent of that id in this repo", 404);

    const grant = permissions ? grantFrom(permissions, { owner: repo.owner, agent: true }) : null;
    // What the owner approves call by call (action-approvals.js): a list of
    // ids, kept apart from the grant - marking a permission "ask first" is
    // not granting it, and taking the grant away leaves the mark harmless.
    const gated = askFirst !== undefined ? cleanAskFirst(askFirst, { owner: repo.owner }) : undefined;
    let nextModel;
    if (model !== undefined) {
      if (!agent.resident) throw new RepoRegistryError("Only an agent that lives in a sandbox has a model to set here", 400);
      // An emptied box is "back to the default" - written as the default's
      // id rather than as nothing, because the running process reports what
      // it thinks with on every poll and a blank would be filled back in
      // from that before the restart that makes the change real.
      nextModel = String(model).trim() || DEFAULT_MODEL;
      const why = whyNotAModel(nextModel);
      if (why) throw new RepoRegistryError(why, 400);
    }
    let nextHarness;
    if (harnessId !== undefined) {
      if (!agent.resident) throw new RepoRegistryError("Only an agent that lives in a sandbox runs in a harness this app picks", 400);
      nextHarness = String(harnessId ?? "").trim();
      if (nextHarness && !/^[a-z0-9_-]{1,40}$/i.test(nextHarness)) throw new RepoRegistryError("Not a harness id", 400);
    }

    await this.writeAgent(repo, agentId, (record) => {
      if (grant) record.permissions = grant;
      if (gated !== undefined) {
        if (gated.length) record.askFirst = gated;
        else delete record.askFirst;
      }
      if (nextModel !== undefined) record.resident.model = nextModel;
      // The harness is a resident's, read at its next start. The id is
      // taken as given - the owner's harnesses are theirs, and one forgotten
      // later falls back to the default (harnesses.js `harnessFor`), so a
      // stale id is a fallback, not a broken record.
      if (nextHarness !== undefined) {
        if (nextHarness) record.resident.harnessId = nextHarness;
        else delete record.resident.harnessId;
      }
    });
    return this.describe(repo, requestedBy);
  }

  /** Take an agent out of this repo. The record stays; `forgetAgent` is the other verb. */
  async removeAgent(id, agentId, requestedBy) {
    const repo = this.get(id);
    this.requireOwner(repo, requestedBy);
    repo.agents = (repo.agents ?? []).filter((entry) => entry.id !== String(agentId));
    await this.save(repo);
    return this.describe(repo, requestedBy);
  }

  /**
   * An agent, gone: the record, and its membership of every repo of this
   * person's. Returns which repos it was in, so the caller can stop a
   * process and clear a seat in each. A resident's process is the caller's
   * to stop first (resident.js `stop` drops the record itself).
   */
  async forgetAgent(email, agentId) {
    const user = normalizeEmail(email);
    const wanted = String(agentId);
    const held = this.findAgent(wanted, user);
    if (!held) return null;
    const repos = [];
    for (const repo of this.repos.values()) {
      if (repo.owner !== user || !this.hasAgent(repo, wanted)) continue;
      repos.push(repo);
      repo.agents = repo.agents.filter((entry) => entry.id !== wanted);
      await this.save(repo);
    }
    await agents.remove(user, wanted).catch(() => null);
    return { agent: held.agent, repos };
  }

  /**
   * Who a token belongs to. The first of possibly several - see
   * `findAllByToken`.
   */
  async findByToken(token) {
    return (await this.findAllByToken(token))[0] ?? null;
  }

  /**
   * Every repo one token reaches, in a stable order.
   *
   * More than one because an agent can be a member of several - see
   * `grantAgent`. The order is the order the registry holds them in, which
   * is stable within a process; whichever is first is only the *default*,
   * and the agent picks from here with `switch_repo`.
   *
   * The record is found through the repo: each membership names an owner,
   * and the owner's row is in memory (`adoptAgents` warms every owner's as
   * the registry loads), so this is a walk over memory, never a scan.
   */
  async findAllByToken(token, { fresh = false } = {}) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return [];
    const hash = hashToken(token);

    const search = () => {
      const found = [];
      for (const repo of this.repos.values()) {
        for (const entry of repo.agents ?? []) {
          // `member` rides along: it is where "moved here at" is kept, and
          // mcp.js reads that to put a reconnecting agent back where it was.
          if (isLegacy(entry)) {
            if (sameHash(entry.tokenHash, hash)) found.push({ repo, agent: entry, member: entry });
            continue;
          }
          const record = agents.findByTokenHash(repo.owner, hash);
          if (record && record.id === entry.id) found.push({ repo, agent: record, member: entry });
        }
      }
      return found;
    };

    await this.load();
    // `fresh` is for the two calls that ask "what have I got" - listing and
    // switching. Finding *something* is no longer proof the answer is
    // complete: a repo granted on another machine, or since this process
    // booted, is a match this registry has never seen. Refreshing only when
    // nothing matched would leave that grant invisible for the life of the
    // process, which looks exactly like the grant not having worked.
    if (fresh) await this.refresh();
    const found = search();
    if (found.length) return found;
    await this.refresh();
    return search();
  }

  /**
   * Remember which repo an agent last moved to.
   *
   * On the membership it moved *to*, with the time, so the newest mark wins
   * when several have one - and on the record, so a process that has not
   * read this repo yet knows too. Written because an MCP session lives in
   * one process: without this, a reconnect - or a request that lands on
   * another machine - would silently put the agent back in the first repo
   * it was let into, and it would carry on working in the wrong place.
   */
  async rememberAgentRepo(repoId, agentId) {
    const repo = this.repos.get(repoId);
    const entry = (repo?.agents ?? []).find((item) => item.id === String(agentId));
    if (!entry) return;
    const at = new Date().toISOString();
    entry.movedHereAt = at;
    await this.save(repo).catch(() => {});
    if (!isLegacy(entry)) {
      await agents.update(repo.owner, entry.id, (record) => {
        record.movedTo = { repoId: String(repoId), at };
      }).catch(() => null);
    }
  }

  /**
   * Somebody changed how the agents work here: a commit that touched
   * CLAUDE.md, a skill, a hook, the settings (harness-changes.js
   * `isHarnessFile`). Kept on the repo so the Performance page can put the
   * fortnight before each one beside the fortnight after it.
   *
   * On the repo rather than in a table of its own because there are a
   * handful of these a month at most, they are read whole whenever they are
   * read at all, and they are meaningless apart from the repository they
   * govern. Deduplicated by sha and bounded by `mergeChanges`, so a
   * redelivered webhook writes nothing new and a year of them cannot grow
   * the record without limit.
   *
   * Nothing is written when nothing changed - a push lands here for every
   * commit on the default branch, and almost none of them are these.
   */
  async noteHarnessChanges(repoId, changes) {
    const repo = this.repos.get(repoId);
    if (!repo || !changes?.length) return null;
    const merged = mergeChanges(repo.harnessChanges ?? [], changes);
    const known = new Set((repo.harnessChanges ?? []).map((change) => change.sha));
    if (merged.length === known.size && merged.every((change) => known.has(change.sha))) return repo.harnessChanges;
    repo.harnessChanges = merged;
    // A change the store did not take is one this process still knows and
    // the next one will not - the panel goes quiet about a commit that did
    // happen. Not worth failing the webhook over, and not worth hiding
    // either: the same shape every other write here takes.
    await this.save(repo).catch((err) => {
      console.warn(`[repos] could not store the harness changes of ${repo.id}: ${err.message}`);
    });
    return merged;
  }

  /** Note that an agent is alive. Persisted lazily - it is only a timestamp. */
  async touchAgent(repoId, agentId) {
    const repo = this.repos.get(repoId);
    const now = Date.now();
    await this.writeAgent(repo, agentId, (record) => {
      // A tool call a second must not be a store write a second.
      if (record.lastSeenAt && now - Date.parse(record.lastSeenAt) < 60_000) return false;
      record.lastSeenAt = new Date(now).toISOString();
    }, { quiet: true });
  }

  /**
   * Remember how a resident was started - the address it reaches this app
   * at and the model it thinks with - so it can be started the same way
   * again without the request that first started it (resident.js `rouse`).
   * Only fills what is missing; nothing is written when nothing changes.
   */
  async noteResident(repoId, agentId, { origin, model }) {
    const repo = this.repos.get(repoId);
    await this.writeAgent(repo, agentId, (record) => {
      if (!record.resident) return false;
      let changed = false;
      if (origin && !record.resident.origin) {
        record.resident.origin = String(origin);
        changed = true;
      }
      if (model && !record.resident.model) {
        record.resident.model = String(model);
        changed = true;
      }
      return changed;
    });
  }

  /**
   * Which engine a resident's process was last declared with (resident.js
   * `install`): the API loop, or Claude Code on the owner's token. Written
   * whenever it changes, so the page says what is actually running.
   */
  async noteResidentEngine(repoId, agentId, engine, harness = null) {
    const repo = this.repos.get(repoId);
    await this.writeAgent(repo, agentId, (record) => {
      if (!record.resident) return false;
      const was = record.resident.harness ?? null;
      const sameHarness = harness == null ? true : was?.id === harness.id && was?.kind === harness.kind;
      if (record.resident.engine === engine && sameHarness) return false;
      record.resident.engine = String(engine);
      if (harness) record.resident.harness = { id: String(harness.id), kind: String(harness.kind) };
    });
  }

  /**
   * A resident seated asleep (`dormant`) has just had its process installed
   * for the first time: from now it is one that was started, and the page
   * that said "not started" starts counting how long it has taken to answer.
   * Nothing is written for one that was started already.
   */
  async noteResidentStarted(repoId, agentId) {
    const repo = this.repos.get(repoId);
    let started = false;
    await this.writeAgent(repo, agentId, (record) => {
      if (!record.resident || record.resident.startedAt) return false;
      record.resident.startedAt = new Date().toISOString();
      started = true;
    });
    if (started) publish("agent.started", { repoId, agentId }, { agentId });
  }

  /**
   * Remember until when an agent's machine is to be kept up.
   *
   * The lease itself is in memory (resident.js) and dies with the process -
   * so every deploy let every machine go, and an agent that had answered a
   * minute earlier read "sleeping" until the next line rang for it. With the
   * deadline on the record the next process holds the machine again for
   * what was left of the hour. Written at most once a minute per agent: a
   * lease is extended by every tool call, and a store write a call is not.
   */
  async noteAwake(repoId, agentId, until) {
    const repo = this.repos.get(repoId);
    await this.writeAgent(repo, agentId, (record) => {
      if (!record.resident) return false;
      const known = Number(record.resident.awakeUntil ?? 0);
      if (until - known < 60_000) return false;
      record.resident.awakeUntil = until;
    }, { quiet: true });
  }

  /**
   * Move every agent still recorded on a repo onto its owner's row, and
   * leave the repo with memberships. Run as the registry loads and on every
   * re-read, because a copy from an older process can bring the old shape
   * back in. Warms every owner's row either way, so the synchronous readers
   * above can answer. Never throws: a row that cannot be written leaves the
   * entry as it was, still readable in the old shape.
   */
  async adoptAgents() {
    const owners = new Set([...this.repos.values()].map((repo) => repo.owner).filter(Boolean));
    await Promise.all([...owners].map((owner) => agents.warm(owner).catch(() => [])));
    for (const repo of this.repos.values()) {
      if (!repo.owner) continue;
      let moved = false;
      const next = [];
      for (const entry of repo.agents ?? []) {
        if (!isLegacy(entry)) {
          next.push(entry);
          continue;
        }
        try {
          const record = await agents.upsertFromLegacy(repo.owner, entry, {
            repoId: repo.id,
            permissions: permissionsOf(repo, entry),
          });
          next.push(memberOf(record, { createdAt: entry.createdAt, createdBy: entry.createdBy, movedHereAt: entry.movedHereAt ?? null }));
          moved = true;
        } catch (err) {
          console.warn(`[repos] could not move agent ${entry.id} of ${repo.id} to its owner's row: ${err.message}`);
          next.push(entry);
        }
      }
      if (!moved) continue;
      repo.agents = next;
      try {
        await this.save(repo);
      } catch (err) {
        console.warn(`[repos] could not store the memberships of ${repo.id}: ${err.message}`);
      }
    }
  }

  async unshare(id, email, requestedBy) {
    const repo = this.get(id);
    this.requireOwner(repo, requestedBy);
    const member = normalizeEmail(email);
    repo.members = repo.members.filter((entry) => entry.email !== member);
    await this.save(repo);
    return this.describe(repo, requestedBy);
  }

  /**
   * Take this person off every repo somebody shared with them.
   *
   * The other half of `removeAllOwnedBy`, for an account that is being
   * deleted rather than reset: what they own goes, and what was lent to them
   * is handed back. Not the owner's call, which is why this is not `unshare`
   * - a member may always leave, and an address that no longer exists is not
   * one an owner should go on seeing in the members list.
   *
   * @returns {Promise<Array<{id: string, name: string}>>} what was left
   */
  async leaveAll(email) {
    const member = normalizeEmail(email);
    if (!member) return [];
    await this.refresh();
    const left = [];
    for (const repo of this.repos.values()) {
      if (!repo.members.some((entry) => entry.email === member)) continue;
      repo.members = repo.members.filter((entry) => entry.email !== member);
      await this.save(repo);
      left.push({ id: repo.id, name: repo.name });
    }
    return left;
  }
}

export const repos = new RepoRegistry();
