// Bitbucket, read with one person's own app password or API token.
//
// The odd one of the three, and the reason the credential is an object
// rather than a string: Bitbucket authenticates with HTTP Basic, so the
// token is only half of it - the account's username is the other half, and
// a form that asked for a token alone would be a form that cannot work.
// Atlassian's newer API tokens are the same shape: username, then secret.
//
// Its words are its own too. A pull request is `OPEN`, `MERGED`, `DECLINED`
// or `SUPERSEDED`; the last two are both "closed" here, because what the
// record is for is whether the work landed and neither of them did. There is
// no `closed_on`, so a settled pull request's `updated_on` is when it
// settled, which is true of every one of them the moment it stops moving.
import { ask, msOf } from "./http.js";
import { mentionsIn, revertsIn } from "./text.js";

export const id = "bitbucket";
export const label = "Bitbucket";
export const web = "https://bitbucket.org";

/** Where the API is, read at the call so a test's fake can be started after this loads. */
export const api = () => (process.env.CODERVIBES_BITBUCKET_API ?? "").trim() || "https://api.bitbucket.org";

export const hint = "It wants your Bitbucket username and an app password with pull request read, or an API token.";

const credentialOf = (credential) => (typeof credential === "string" ? { token: credential } : credential ?? {});

/**
 * Why this is not a Bitbucket credential, or null when it might be.
 *
 * An app password is a random string with no prefix to check, so the only
 * shape there is to hold is that both halves are there. The username is the
 * one people leave out, because every other host on this page takes a token
 * alone.
 */
export function whyNotAToken(credential) {
  const { username, token } = credentialOf(credential);
  if (!String(token ?? "").trim()) return "Paste a Bitbucket app password, or an API token.";
  if (!String(username ?? "").trim()) {
    return "Bitbucket needs the account's username as well - it signs in with both, not with the password alone.";
  }
  return null;
}

const auth = (credential) => {
  const { username, token } = credentialOf(credential);
  const pair = Buffer.from(`${String(username ?? "").trim()}:${String(token ?? "").trim()}`, "utf8").toString("base64");
  return { Authorization: `Basic ${pair}` };
};

const host = { id, label, hint };

export async function verify(credential) {
  const me = await ask(`${api()}/2.0/user`, { host, headers: auth(credential) });
  return { account: me?.username ?? me?.nickname ?? me?.display_name ?? null };
}

const cut = (text, n) => {
  const line = String(text ?? "").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** One pull request from Bitbucket's JSON, in the one shape every host answers in. */
function shapeOf(pull, fullName = null) {
  const said = String(pull.state ?? "").toUpperCase();
  const state = said === "MERGED" ? "merged" : said === "DECLINED" || said === "SUPERSEDED" ? "closed" : "open";
  const settled = state === "open" ? null : msOf(pull.updated_on);
  return {
    host: id,
    repo: pull.destination?.repository?.full_name ?? pull.source?.repository?.full_name ?? fullName,
    number: Number(pull.id),
    title: cut(pull.title, 200) || null,
    url: pull.links?.html?.href ?? null,
    state,
    headRef: pull.source?.branch?.name ?? null,
    baseRef: pull.destination?.branch?.name ?? null,
    mergeCommitSha: pull.merge_commit?.hash ?? null,
    author: pull.author ? { login: pull.author.nickname ?? pull.author.username ?? pull.author.display_name ?? null, bot: false } : null,
    draft: Boolean(pull.draft),
    openedAt: msOf(pull.created_on),
    updatedAt: msOf(pull.updated_on),
    mergedAt: state === "merged" ? settled : null,
    closedAt: settled,
    // Bitbucket says how big a pull request is only in its diffstat, which
    // is a second read per pull request. Unsaid rather than nought.
    additions: null,
    deletions: null,
    changedFiles: null,
    mentions: mentionsIn(pull.title, pull.description),
    reverts: revertsIn(pull.title, pull.description),
  };
}

export async function describePull({ fullName, number, credential, signal } = {}) {
  const [workspace, repo] = String(fullName ?? "").split("/");
  const pull = await ask(
    `${api()}/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${Number(number)}`,
    { host, headers: auth(credential), signal },
  );
  return pull ? shapeOf(pull, fullName) : null;
}

/**
 * The person's own pull requests, updated since.
 *
 * `/2.0/pullrequests/{username}` is the one endpoint that answers across
 * repositories, and it answers with open ones only unless every state is
 * asked for by name - a listing that left them out would be a sweep that
 * never learns anything merged, which is the only thing it is for.
 */
export async function listMine({ credential, since = Date.now() - 30 * 24 * 60 * 60_000, limit = 100, signal } = {}) {
  const { username } = credentialOf(credential);
  const query = new URLSearchParams({
    q: `updated_on>=${new Date(since).toISOString()}`,
    sort: "-updated_on",
    pagelen: String(Math.min(50, Math.max(1, limit))),
  });
  for (const state of ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]) query.append("state", state);
  const listed = await ask(`${api()}/2.0/pullrequests/${encodeURIComponent(String(username ?? "").trim())}?${query}`, {
    host,
    headers: auth(credential),
    signal,
  });
  return (listed?.values ?? [])
    .slice(0, limit)
    .map((pull) => shapeOf(pull))
    .filter((pull) => pull.repo && pull.number);
}
