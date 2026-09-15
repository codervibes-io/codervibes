// GitHub, read with one person's own token.
//
// Not connectors/github.js and not repo-sources/github.js: both of those are
// the installation's GitHub - an App, an installation id, a token minted per
// repository, a write path that opens pull requests and merges them. This is
// the other half of the same host, the one a person can have without any of
// that: a personal access token, and the two reads that say what became of
// the pull requests they opened.
//
// Everything below is the host contract (index.js). The same four exports
// exist for GitLab and Bitbucket, which is the whole point of the file being
// this shape.
import { ask, msOf } from "./http.js";
import { mentionsIn, revertsIn } from "./text.js";

export const id = "github";
export const label = "GitHub";
export const web = "https://github.com";

/**
 * Where the API is, asked each time rather than read once.
 *
 * The same variable connectors/github.js reads, so an installation that
 * points one at a fake points both - and read at the call rather than at
 * the import, because a test starts its fake after this module is loaded.
 */
export const api = () => (process.env.CODERVIBES_GITHUB_API ?? "").trim() || "https://api.github.com";

/** What the token has to be able to do, said wherever GitHub refuses one. */
export const hint = "It wants a personal access token that can read pull requests on your repositories.";

/** The token prefixes GitHub mints: classic, fine-grained, and an OAuth app's. */
const PREFIXES = ["ghp_", "github_pat_", "gho_"];

/** The credential, however it was handed in: a bare token is `{ token }`. */
const credentialOf = (credential) => (typeof credential === "string" ? { token: credential } : credential ?? {});

/**
 * Why this is not a GitHub token, or null when it might be.
 *
 * A shape check, not a verification: `verify` is what actually asks GitHub.
 * It is here because a typo caught before the call is a sentence about the
 * token, and the same typo caught by GitHub is a 401 about credentials.
 */
export function whyNotAToken(credential) {
  const token = String(credentialOf(credential).token ?? "").trim();
  if (!token) return "Paste a GitHub personal access token.";
  if (!PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return "That does not look like a GitHub token - they begin with ghp_ or github_pat_.";
  }
  return null;
}

const auth = (credential) => ({
  Authorization: `Bearer ${String(credentialOf(credential).token ?? "").trim()}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

const host = { id, label, hint };

/** Whose token this is. The one call every connection is checked with. */
export async function verify(credential) {
  const me = await ask(`${api()}/user`, { host, headers: auth(credential) });
  return { account: me?.login ?? null };
}

/** A person, or one of GitHub's bots, as a record keeps them. */
const who = (user) => (user ? { login: user.login ?? null, bot: user.type === "Bot" } : null);

const cut = (text, n) => {
  const line = String(text ?? "").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** One pull request from GitHub's JSON, in the one shape every host answers in. */
function shapeOf(pull, fullName) {
  return {
    host: id,
    repo: fullName ?? pull.base?.repo?.full_name ?? null,
    number: Number(pull.number),
    title: cut(pull.title, 200) || null,
    url: pull.html_url ?? null,
    state: pull.merged || pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
    headRef: pull.head?.ref ?? null,
    baseRef: pull.base?.ref ?? null,
    // What a revert commit names, and the only way a `git revert` pushed by
    // hand can be tied back to the pull request it undoes.
    mergeCommitSha: pull.merge_commit_sha ?? null,
    author: who(pull.user),
    draft: Boolean(pull.draft),
    openedAt: msOf(pull.created_at),
    updatedAt: msOf(pull.updated_at),
    mergedAt: msOf(pull.merged_at),
    closedAt: msOf(pull.closed_at),
    // Null is "this answer did not say", never nought: GitHub sends the
    // three on a read of one pull request and leaves them off a listing,
    // and folding a missing figure in as zero would erase a real one.
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    changedFiles: pull.changed_files ?? null,
    mentions: mentionsIn(pull.title, pull.body),
    reverts: revertsIn(pull.title, pull.body),
  };
}

/** What one pull request says about itself. */
export async function describePull({ fullName, number, credential, signal } = {}) {
  const [owner, name] = String(fullName ?? "").split("/");
  const pull = await ask(`${api()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${Number(number)}`, {
    host,
    headers: auth(credential),
    signal,
  });
  return pull ? shapeOf(pull, fullName) : null;
}

/** How far back the search asks: GitHub's search takes a date, not a moment. */
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * The person's own pull requests, updated since.
 *
 * Two steps, because GitHub's search answers in the issue shape - no head,
 * no base, no merge commit, and "closed" for a merge - and the fold wants
 * all four. The search is one call whatever the answer's size; the reads
 * after it are one per pull request, which is why `limit` is small and why
 * nothing here pages.
 */
export async function listMine({ credential, since = Date.now() - 30 * 24 * 60 * 60_000, limit = 100, signal } = {}) {
  const query = `is:pr author:@me updated:>=${dayOf(since)}`;
  const found = await ask(
    `${api()}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${Math.min(100, Math.max(1, limit))}`,
    { host, headers: auth(credential), signal },
  );
  const out = [];
  for (const item of (found?.items ?? []).slice(0, limit)) {
    // The repository is not a field of a search result; it is the tail of
    // `repository_url`, which is.
    const fullName = /\/repos\/([^/]+\/[^/]+)/.exec(String(item.repository_url ?? item.url ?? ""))?.[1] ?? null;
    if (!fullName || !item.number) continue;
    const described = await describePull({ fullName, number: item.number, credential, signal }).catch(() => null);
    if (described) out.push(described);
  }
  return out;
}
