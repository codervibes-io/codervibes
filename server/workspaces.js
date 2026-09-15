// Workspaces: who works with whom.
//
// A workspace is a group of people. What it is *for* is deciding who sees
// what: a repo belongs to exactly one workspace, the people in a workspace
// see the repos in it (and the sessions, machines and activity those repos
// produce), and nobody else does. Everything the console shows is shown for
// the workspace the viewer currently has open, so two teams on one
// installation never see each other's work, and one person on two teams
// keeps them apart by switching.
//
// It is *not* a permission model. What somebody may do in a repo is still
// the repo's grant (repos.js `permissionsFor`); membership of the workspace
// only puts them in the room, as a reader, until the owner grants more.
//
// Everybody has a personal workspace, made for them the first time anything
// needs one, so "a repo with no workspace" is not a state and the code above
// this never has to handle it. Repos from before workspaces are put in their
// owner's personal one at boot (repos.js `adoptWorkspaces`).
//
// Not to be confused with what this app used to call a workspace - the
// thing now called a repo (commit fbc8ec2). A checkout or a store from
// before the rename may still hold that document under this name; `isOne`
// tells the two shapes apart so an old repo record never reads as a group.
import { randomBytes } from "node:crypto";
import { store } from "./store/index.js";
import { field } from "./user-record.js";
import { LIMITS, LimitError } from "./limits.js";
import { publish } from "./events.js";

export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();

const isEmail = (email) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email);

/** Long enough for any name, short enough that it is one - the same cap as an account name. */
export const MAX_NAME = 80;

/** The roles a member can hold. The owner is whoever made it; there is one. */
export const ROLES = ["owner", "member"];

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace"
  );
}

/**
 * Whether a stored record is one of ours. A pre-rename repo record has a
 * `dir` and an `owner` and no member has a role; a workspace has neither of
 * the first two and every member has one.
 */
export function isOne(record) {
  return Boolean(record) && typeof record.id === "string" && !("dir" in record) && Array.isArray(record.members);
}

function withShape(workspace) {
  workspace.members ??= [];
  return workspace;
}

class WorkspaceRegistry {
  constructor() {
    this.workspaces = new Map();
    this.loaded = false;
    this.loading = null;
  }

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
    let records;
    try {
      records = await store.loadWorkspaces();
    } catch (err) {
      throw new Error(`Could not load workspaces from ${store.name}: ${err.message}`);
    }
    let skipped = 0;
    for (const record of records) {
      if (!isOne(record)) {
        skipped += 1;
        continue;
      }
      this.workspaces.set(record.id, withShape(record));
    }
    if (skipped) {
      console.warn(
        `[workspaces] ${skipped} record(s) in the workspaces store are not workspaces - ` +
          `they look like repo records from before the rename (commit fbc8ec2). Ignored; ` +
          `drop the old document or table.`,
      );
    }
    this.loaded = true;
  }

  /**
   * Re-read from the store - the other machine behind the proxy may have
   * made or changed one. Same revision rule as repos.js `refresh`: a
   * re-read never takes memory backwards.
   */
  async refresh() {
    let fresh;
    try {
      fresh = await store.loadWorkspaces();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const seen = new Set();
    for (const record of fresh) {
      if (!isOne(record)) continue;
      seen.add(record.id);
      const held = this.workspaces.get(record.id);
      if (held && (held.rev ?? 0) > (record.rev ?? 0)) continue;
      this.workspaces.set(record.id, withShape({ ...held, ...record }));
    }
    for (const id of [...this.workspaces.keys()]) {
      if (!seen.has(id)) this.workspaces.delete(id);
    }
    return { ok: true, error: null };
  }

  async save(workspace) {
    if (!this.workspaces.has(workspace.id)) return;
    workspace.rev = (workspace.rev ?? 0) + 1;
    await store.putWorkspace(workspace);
    // Addressed to its members, so each of their consoles re-reads the
    // session - the switcher, the member list - and nobody else's does.
    publish("workspace.saved", { users: workspace.members.map((member) => member.email) }, { workspaceId: workspace.id });
  }

  // ------------------------------------------------------------- reading

  get(id) {
    const workspace = this.workspaces.get(String(id ?? ""));
    if (!workspace) throw new WorkspaceError(`No workspace '${id}'`, 404);
    return workspace;
  }

  /** The record, or null - for readers that would rather fall back than throw. */
  find(id) {
    return this.workspaces.get(String(id ?? "")) ?? null;
  }

  memberOf(workspace, email) {
    const user = normalizeEmail(email);
    return (workspace?.members ?? []).find((member) => member.email === user) ?? null;
  }

  isMember(workspace, email) {
    return Boolean(this.memberOf(workspace, email));
  }

  /**
   * The demo: one workspace, shared, that anybody may read - including
   * somebody who has not signed in. Written by scripts/seed-demo.mjs and
   * marked `public` there; nothing in the app makes one, so there is at most
   * one and no route can turn an ordinary workspace into it.
   */
  isDemo(workspace) {
    return Boolean(workspace?.public);
  }

  /** The demo workspace, or null when this installation was never seeded. */
  demo() {
    for (const workspace of this.workspaces.values()) {
      if (this.isDemo(workspace)) return workspace;
    }
    return null;
  }

  /**
   * May they *look* at it? Membership, or the demo, which is everybody's.
   *
   * Deliberately not `isMember`. Looking and acting have come apart here the
   * same way they have on a repo (repos.js `canAccess`): the demo has to be
   * readable by a visitor with no account at all, and if that were spelled
   * as membership then `requireMember` would let the same visitor rename the
   * workspace, invite people to it and delete it. So the acting paths keep
   * asking `isMember`, which says no to everyone here - the demo's members
   * are the made-up people in it - and only the reading paths ask this.
   */
  canSee(workspace, email) {
    return this.isMember(workspace, email) || this.isDemo(workspace);
  }

  isOwner(workspace, email) {
    return this.memberOf(workspace, email)?.role === "owner";
  }

  requireMember(workspace, email) {
    if (!this.isMember(workspace, email)) throw new WorkspaceError("You are not in this workspace", 403);
  }

  /**
   * What the switcher asks: you may open what you may look at. Not
   * `requireMember` - the demo is on everybody's list and nobody is a member
   * of it, so switching into it has to be allowed by the looking rule.
   */
  requireSeen(workspace, email) {
    if (!this.canSee(workspace, email)) throw new WorkspaceError("You are not in this workspace", 403);
  }

  requireOwner(workspace, email) {
    if (!this.isOwner(workspace, email)) {
      throw new WorkspaceError("Only the workspace's owner can do that", 403);
    }
  }

  /**
   * Every workspace this person can see, personal one first, then by name,
   * with the demo last - it is on everybody's switcher, including that of
   * somebody with no account, and it should never come before their own
   * work. A signed-out caller sees the demo and nothing else.
   *
   * `demo: false` leaves the demo out, whoever is asking - the main site of
   * an installation whose demo lives on a hostname of its own (session.js
   * `demoReachable`), where the demo is reachable through that hostname
   * and not through the switcher.
   */
  listFor(email, { demo = true } = {}) {
    const user = normalizeEmail(email);
    return [...this.workspaces.values()]
      .filter((workspace) => this.canSee(workspace, user) && (demo || !this.isDemo(workspace)))
      .sort((a, b) => {
        if (this.isDemo(a) !== this.isDemo(b)) return this.isDemo(a) ? 1 : -1;
        if ((a.personalOf === user) !== (b.personalOf === user)) return a.personalOf === user ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((workspace) => this.describe(workspace, user));
  }

  describe(workspace, email) {
    const user = normalizeEmail(email);
    return {
      id: workspace.id,
      name: workspace.name,
      // The one made for them at first need. Cannot be deleted, so the
      // console does not offer to.
      personal: workspace.personalOf === user,
      // The shared demo. The console reads this to say so on the page and to
      // leave out every control that would write - a visitor holds no role
      // here, and nor does a signed-in person: nobody is a member of it.
      demo: this.isDemo(workspace),
      role: this.memberOf(workspace, user)?.role ?? null,
      createdAt: workspace.createdAt,
      createdBy: workspace.createdBy,
      members: workspace.members.map((member) => ({
        email: member.email,
        role: member.role,
        joinedAt: member.joinedAt,
        invitedBy: member.invitedBy ?? null,
      })),
    };
  }

  // ----------------------------------------------------------- mutations

  /**
   * The workspace this person starts in, made if they have none. Called
   * from every session, so it is cheap when it exists and, when it does not,
   * refreshes first: the other machine may have made it a moment ago, and
   * two personal workspaces for one person would be a state nothing above
   * this can explain.
   */
  async personalOf(email) {
    const user = normalizeEmail(email);
    if (!user) return null;
    const held = this.findPersonal(user);
    if (held) return held;
    await this.refresh();
    const found = this.findPersonal(user);
    if (found) return found;
    const chosen = await field(user, "name", null);
    const name = `${chosen || user.split("@")[0]}'s workspace`;
    return this.make(name, user, { personalOf: user });
  }

  findPersonal(user) {
    for (const workspace of this.workspaces.values()) {
      if (workspace.personalOf === user) return workspace;
    }
    return null;
  }

  async create(name, email) {
    const user = normalizeEmail(email);
    if (!user) throw new WorkspaceError("Sign in before creating a workspace", 401);
    const owned = [...this.workspaces.values()].filter((workspace) => this.isOwner(workspace, user)).length;
    if (owned >= LIMITS.maxWorkspacesPerUser) {
      throw new LimitError(
        `You already have ${LIMITS.maxWorkspacesPerUser} workspaces, which is the limit. Delete one to make room.`,
        { status: 403, limit: LIMITS.maxWorkspacesPerUser },
      );
    }
    const workspace = await this.make(name, user);
    return this.describe(workspace, user);
  }

  async make(name, user, { personalOf = null } = {}) {
    const trimmed = String(name ?? "").trim().slice(0, MAX_NAME);
    if (!trimmed) throw new WorkspaceError("A workspace needs a name");
    // Random suffix for the same reason a repo's id has one: two teams
    // called "platform" must not race for one id.
    const base = slugify(trimmed);
    let id = `${base}-${randomBytes(3).toString("hex")}`;
    while (this.workspaces.has(id)) id = `${base}-${randomBytes(3).toString("hex")}`;
    const now = new Date().toISOString();
    const workspace = {
      id,
      name: trimmed,
      createdAt: now,
      createdBy: user,
      members: [{ email: user, role: "owner", joinedAt: now, invitedBy: null }],
    };
    if (personalOf) workspace.personalOf = personalOf;
    this.workspaces.set(id, workspace);
    await this.save(workspace);
    return workspace;
  }

  async rename(id, name, email) {
    const workspace = this.get(id);
    this.requireOwner(workspace, email);
    const trimmed = String(name ?? "").trim().slice(0, MAX_NAME);
    if (!trimmed) throw new WorkspaceError("A workspace needs a name");
    workspace.name = trimmed;
    await this.save(workspace);
    return this.describe(workspace, email);
  }

  /**
   * Let somebody in. Any member may - "invite each other" is the point of
   * the thing - and inviting somebody already in is a no-op rather than an
   * error, so two people inviting the same colleague do not race to fail.
   * Returns whether anything changed, so the caller knows whether to mail.
   */
  async invite(id, email, invitedByEmail) {
    const workspace = this.get(id);
    const by = normalizeEmail(invitedByEmail);
    this.requireMember(workspace, by);
    const member = normalizeEmail(email);
    if (!isEmail(member)) throw new WorkspaceError(`'${email}' is not a valid email address`);
    if (this.isMember(workspace, member)) return { workspace: this.describe(workspace, by), added: false };
    if (workspace.members.length >= LIMITS.maxMembersPerWorkspace) {
      throw new LimitError(
        `A workspace can hold at most ${LIMITS.maxMembersPerWorkspace} people.`,
        { status: 403, limit: LIMITS.maxMembersPerWorkspace },
      );
    }
    workspace.members.push({ email: member, role: "member", joinedAt: new Date().toISOString(), invitedBy: by });
    await this.save(workspace);
    return { workspace: this.describe(workspace, by), added: true };
  }

  /**
   * Take somebody out - the owner removing a member, or a member leaving.
   * The owner cannot leave: a workspace with nobody to run it is a state
   * nothing handles, and deleting it is the verb for "I am done with this".
   */
  async remove(id, email, requestedBy) {
    const workspace = this.get(id);
    const by = normalizeEmail(requestedBy);
    const leaving = normalizeEmail(email);
    // Whether they may, before what they asked: a member told "the owner
    // cannot leave" when they tried to remove the owner has been told the
    // wrong thing.
    if (leaving !== by) this.requireOwner(workspace, by);
    const target = this.memberOf(workspace, leaving);
    if (!target) throw new WorkspaceError("They are not in this workspace", 404);
    if (target.role === "owner") {
      throw new WorkspaceError("The owner cannot leave a workspace. Delete it instead, or hand it to somebody first.", 400);
    }
    workspace.members = workspace.members.filter((member) => member !== target);
    await this.save(workspace);
    // The one leaving hears too - `save` addresses the members, and they
    // are no longer one.
    publish("workspace.saved", { users: [leaving] }, { workspaceId: workspace.id });
    return this.describe(workspace, by);
  }

  /**
   * Gone. Only when it holds nothing: `holds` says whether any repo is in
   * it, and is the caller's because this module knows nothing about repos.
   */
  async destroy(id, email, { holds }) {
    const workspace = this.get(id);
    this.requireOwner(workspace, email);
    if (workspace.personalOf) {
      throw new WorkspaceError("The workspace you started with cannot be deleted", 400);
    }
    if (holds(workspace.id)) {
      throw new WorkspaceError("Move or delete the repos in this workspace before deleting it", 400);
    }
    const members = workspace.members.map((member) => member.email);
    this.workspaces.delete(workspace.id);
    await store.deleteWorkspace(workspace.id);
    publish("workspace.forgotten", { users: members }, { workspaceId: workspace.id });
  }

  /**
   * Everything of this person's, undone - for the account reset and the
   * account delete. Ones they own go if they were alone in them; one with
   * other people in it is handed to whoever has been there longest, because
   * the others' repos are in it (a repo's owner is always a member of its
   * workspace - repos.js keeps that) and a room with no owner is a state
   * nothing handles. Ones they are merely in, they leave - unless `owned`
   * says only what they own: a reset keeps the repos other people shared,
   * so it keeps the workspaces those repos are in.
   */
  async forgetUser(email, { owned = false } = {}) {
    const user = normalizeEmail(email);
    for (const workspace of [...this.workspaces.values()]) {
      const member = this.memberOf(workspace, user);
      if (!member) continue;
      if (owned && member.role !== "owner") continue;
      const rest = workspace.members.filter((entry) => entry !== member);
      if (member.role === "owner" && !rest.length) {
        this.workspaces.delete(workspace.id);
        await store.deleteWorkspace(workspace.id);
        publish("workspace.forgotten", { users: [user] }, { workspaceId: workspace.id });
        continue;
      }
      if (member.role === "owner") {
        const heir = [...rest].sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)))[0];
        heir.role = "owner";
        // No longer the room this person starts in - the next sign-in
        // makes them a fresh one rather than finding this one, full of
        // somebody else's work.
        delete workspace.personalOf;
      }
      workspace.members = rest;
      await this.save(workspace);
    }
  }
}

export const workspaces = new WorkspaceRegistry();
