// GitLab, read with one person's own token.
//
// A merge request is a pull request with different words on it, and the
// only two that reach a record here are the branch it came from and whether
// it merged. So the whole of this file is translation: GitLab's `iid` is the
// number a person sees (`id` is a global one nobody quotes), `opened` is
// what it calls open, `source_branch` is the head ref, and a project's name
// is a path that may be several segments deep - `group/team/project` - which
// is why every place a repository is put in a URL encodes it whole.
//
// What GitLab does not say is how big a merge request is. `changes_count` is
// a count of files and a string ("12", or "1000+" when it gave up), and
// there is no additions/deletions figure short of reading the diff. So the
// two line counts are null, which the fold takes as "this answer did not
// say" and leaves whatever it had.
import { ask, msOf } from "./http.js";
import { mentionsIn, revertsIn } from "./text.js";

export const id = "gitlab";
export const label = "GitLab";
export const web = "https://gitlab.com";

/** Where the API is, read at the call so a test's fake can be started after this loads. */
export const api = () => (process.env.CODERVIBES_GITLAB_API ?? "").trim() || "https://gitlab.com/api/v4";

export const hint = "It wants a personal access token with the read_api scope.";

const credentialOf = (credential) => (typeof credential === "string" ? { token: credential } : credential ?? {});

/** Why this is not a GitLab token, or null when it might be. */
export function whyNotAToken(credential) {
  const token = String(credentialOf(credential).token ?? "").trim();
  if (!token) return "Paste a GitLab personal access token.";
  if (!token.startsWith("glpat-")) return "That does not look like a GitLab token - a personal access token begins with glpat-.";
  return null;
}

// PRIVATE-TOKEN rather than a bearer: it is the header GitLab documents for
// a personal access token, and the one a self-hosted instance behind a
// reverse proxy is least likely to have taken for its own.
const auth = (credential) => ({ "PRIVATE-TOKEN": String(credentialOf(credential).token ?? "").trim() });

const host = { id, label, hint };

export async function verify(credential) {
  const me = await ask(`${api()}/user`, { host, headers: auth(credential) });
  return { account: me?.username ?? null };
}

const cut = (text, n) => {
  const line = String(text ?? "").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/**
 * The project a merge request belongs to, as a path.
 *
 * `references.full` is `group/sub/project!7` when GitLab sends it; the web
 * URL is the fallback, and is what a merge request read out of the person's
 * own listing carries. Either way the answer is the path, whole - a
 * subgroup is part of a project's name, not a namespace to drop.
 */
export function projectOf(merge, fallback = null) {
  const referenced = String(merge?.references?.full ?? "").split("!")[0].trim();
  if (referenced.includes("/")) return referenced;
  const web = String(merge?.web_url ?? "");
  const found = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(web);
  return found ? found[1] : fallback;
}

/** How many files it touched: GitLab's own string, as a number where it is one. */
const filesIn = (value) => {
  const found = /^(\d+)/.exec(String(value ?? "").trim());
  return found ? Number(found[1]) : null;
};

/** One merge request from GitLab's JSON, in the one shape every host answers in. */
function shapeOf(merge, fullName = null) {
  const state = merge.state === "merged" ? "merged" : merge.state === "closed" || merge.state === "locked" ? "closed" : "open";
  return {
    host: id,
    repo: projectOf(merge, fullName),
    number: Number(merge.iid),
    title: cut(merge.title, 200) || null,
    url: merge.web_url ?? null,
    state,
    headRef: merge.source_branch ?? null,
    baseRef: merge.target_branch ?? null,
    mergeCommitSha: merge.merge_commit_sha ?? merge.squash_commit_sha ?? null,
    // GitLab has no bots of its own to mark: a service account is an account.
    author: merge.author ? { login: merge.author.username ?? null, bot: Boolean(merge.author.bot) } : null,
    draft: Boolean(merge.draft ?? merge.work_in_progress),
    openedAt: msOf(merge.created_at),
    updatedAt: msOf(merge.updated_at),
    mergedAt: msOf(merge.merged_at),
    closedAt: msOf(merge.closed_at) ?? (state === "merged" ? msOf(merge.merged_at) : null),
    // GitLab says nothing about how many lines moved without a read of the
    // diff, so these stay unsaid rather than becoming nought.
    additions: null,
    deletions: null,
    changedFiles: filesIn(merge.changes_count),
    mentions: mentionsIn(merge.title, merge.description),
    reverts: revertsIn(merge.title, merge.description),
  };
}

export async function describePull({ fullName, number, credential, signal } = {}) {
  const project = encodeURIComponent(String(fullName ?? ""));
  const merge = await ask(`${api()}/projects/${project}/merge_requests/${Number(number)}`, {
    host,
    headers: auth(credential),
    signal,
  });
  return merge ? shapeOf(merge, fullName) : null;
}

/**
 * The person's own merge requests, updated since - one call, whole records.
 *
 * GitLab's top-level `/merge_requests` is already scoped to the person
 * asking, so `scope=created_by_me` is the whole of "mine" and there is no
 * second read per merge request the way GitHub's search needs one.
 */
export async function listMine({ credential, since = Date.now() - 30 * 24 * 60 * 60_000, limit = 100, signal } = {}) {
  const query = new URLSearchParams({
    scope: "created_by_me",
    state: "all",
    updated_after: new Date(since).toISOString(),
    order_by: "updated_at",
    sort: "desc",
    per_page: String(Math.min(100, Math.max(1, limit))),
  });
  const listed = await ask(`${api()}/merge_requests?${query}`, { host, headers: auth(credential), signal });
  return (Array.isArray(listed) ? listed : [])
    .slice(0, limit)
    .map((merge) => shapeOf(merge))
    .filter((merge) => merge.repo && merge.number);
}
