// Where a piece of work happened, from the open workspace's point of view.
//
// A session names a repository - the remote of the checkout its harness
// reported (telemetry-ingest.js `start`) - and sometimes a repo of this
// installation, the registration somebody made of that repository
// (connect-repo.js). Until now only the second counted: work in a repository
// nobody had connected here reached no workspace and appeared on no page,
// and so did work in no repository at all. That was deliberate - a person's
// own setup reports every terminal they open, and for a day in September
// every side project on a laptop was on the Home page of every workspace of
// theirs - but the cure took the useful with the noisy. Most of what an
// agent does for a team is in repositories the team does not administer and
// could not install a GitHub App on, and a good deal of it is in no
// repository: a spike in a scratch directory, a question answered, a
// migration script run against a database.
//
// So work reaches a workspace three ways, and which one is on the record the
// pages read, because a row that does not say is worse than no row:
//
//   - `workspace` - it names a repo of this workspace. What every listing
//     has always shown, and still all any of them shows by default.
//   - `external` - it names a repository, but no repo of this workspace is
//     of that repository. Nobody registered it here; nothing was installed
//     on it; this app has no token for it and makes no claim about it
//     beyond the name the harness reported.
//   - `none` - it names no repository at all.
//
// The last two reach a workspace by their *owner*: the person was working,
// the person is in this workspace, so their colleagues can see they were
// working - which is the whole of what a team wants from it. They are off
// every listing until somebody asks for them (`parse`), so the default page
// is still the workspace's repos' work and the September noise stays off it.
//
// What is *not* here is a repo record per external repository. An adopted
// record would count against its owner's repo quota (repos.js LIMITS - an
// agent working across thirty repositories would start being told it has
// too many), would sit on the Workspace page looking exactly like a repo
// somebody connected, and would have no token, no branch and no verification
// that the repository is even real behind it. The session already carries
// the repository's name, which is everything a row, a chip and a filter
// need; the registration is what "connected here" means, and inventing one
// would make the word mean nothing.
import { repos } from "./repos.js";
import { workspaces } from "./workspaces.js";

/** The three, in the order a page offers them. */
export const WHERES = ["workspace", "external", "none"];

/** What a listing shows when the caller does not say: this workspace's repos, as ever. */
export const DEFAULT_WHERES = ["workspace"];

/**
 * Which of the three this piece of work is, seen from one workspace - or
 * null when it is not that workspace's at all.
 *
 * `repoId` and `repository` are how work names where it was done: the id of
 * a repo here, and the `owner/name` of the repository its checkout is of.
 * Either can be absent. A repo of the workspace wins over the owner, so
 * work in a connected repository is `workspace` whoever did it.
 *
 * @param {string|null} scope the workspace being looked at
 * @param {{repoId?: string|null, repository?: string|null, host?: string|null, owner?: string|null}} work
 * @returns {"workspace"|"external"|"none"|null}
 */
export function whereIn(scope, { repoId = null, repository = null, host = "github", owner = null } = {}) {
  if (!scope) return null;
  // The demo shows the demo's work and nobody else's.
  //
  // It is the one workspace a visitor with no account can read, and its
  // repos are readable by everybody (repos.js `canAccess`) - so they are in
  // everybody's reach, and work of a real person's that named one of them
  // passed the repo test below and went out on a public page. It happened:
  // a live session, the owner's address and a link to their pull request
  // were served to anyone who opened the demo.
  //
  // The demo's own people are the twenty-five the seed invents, so this
  // costs the demo nothing and every other workspace a membership check it
  // was doing anyway. Refused rather than repaired on the way past: nothing
  // real belongs here, so there is no right way to show it.
  if (isDemo(scope) && !workspaces.isMember(workspaces.find(scope), owner)) return null;
  const own = repoId ? repos.repos.get(repoId)?.workspace ?? null : null;
  if (own === scope) return "workspace";
  // The host as well as the name: a repo here is a repository on GitHub,
  // and work on a GitLab project that happens to have the same path is not
  // that repo's (repos.js `ofRepository`).
  for (const repo of repository ? repos.ofRepository(repository, host) : []) {
    if (repo.workspace === scope) return "workspace";
  }
  // Not this workspace's repo. It is still this workspace's business if the
  // person who did it works here - and nobody else's.
  if (!owner || !workspaces.isMember(workspaces.find(scope), owner)) return null;
  return repository ? "external" : "none";
}

/** Whether a workspace id is the shared demo's. */
const isDemo = (scope) => workspaces.isDemo(workspaces.find(scope));

/**
 * The workspaces a piece of work reaches, by id - `whereIn` over every
 * workspace, for the reads that ask "anywhere" rather than "here"
 * (index.js `sessionVisible`).
 */
export function roomsOf({ repoId = null, repository = null, host = "github", owner = null } = {}) {
  const rooms = new Set();
  const own = repoId ? repos.repos.get(repoId)?.workspace ?? null : null;
  if (own) rooms.add(own);
  for (const repo of repository ? repos.ofRepository(repository, host) : []) if (repo.workspace) rooms.add(repo.workspace);
  // The owner's own workspaces, for work in none of their repos. Their
  // personal one is in the list, so a person's scratch work is always
  // somewhere they can find it.
  for (const workspace of owner ? workspaces.listFor(owner) : []) rooms.add(workspace.id);
  return [...rooms];
}

/**
 * What a request asked to see, from `?where=` - a comma-joined subset of
 * WHERES. `workspace` is always in the answer: the page's own repos are
 * not something a filter takes away, and a request for nothing at all is a
 * blank page nobody meant to ask for. An unknown word is dropped rather
 * than refused, so an old link keeps working.
 *
 * @returns {string[]} a subset of WHERES, always containing "workspace"
 */
export function parse(param) {
  const asked = String(param ?? "")
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter((word) => WHERES.includes(word));
  return [...new Set(["workspace", ...asked])];
}
