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
//
// A sign-in is the exception, and it is why the credential is read rather
// than assumed: an OAuth grant is `Authorization: Bearer` and carries no
// username at all. Both shapes are taken here, because both are one
// person's Bitbucket and nothing downstream should have to know which.
import { HostError, ask, msOf } from "./http.js";
import { mentionsIn, revertsIn } from "./text.js";

export const id = "bitbucket";
export const label = "Bitbucket";
export const web = "https://bitbucket.org";

/** Where the API is, read at the call so a test's fake can be started after this loads. */
export const api = () => (process.env.CODERVIBES_BITBUCKET_API ?? "").trim() || "https://api.bitbucket.org";

export const hint = "It wants your Bitbucket username and an app password with pull request read, or an API token.";

/**
 * One value as the credential it is: `{username, token}`, or `{token,
 * bearer}` for a sign-in's grant.
 *
 * Two halves out of one string, because there are places a credential is
 * exactly one value and Bitbucket's is two - a connector's secret on the
 * cloud's Connectors page is one box, and a form with a second box for one
 * host out of three is a form the rest of the page does not have. So the
 * pair is written the way Bitbucket's own Basic header holds it,
 * `username:app-password`, and split back here.
 *
 * A value with no colon in it is a bearer token: an app password is always
 * given with its username, and an OAuth access token never has one. It is a
 * guess, and it is the right one - a Bitbucket app password cannot contain a
 * colon, so a value with none is either a grant or half a credential, and
 * half a credential is refused by the host on the first call either way.
 */
export function credentialFrom(secret) {
  if (secret && typeof secret === "object") return secret;
  const text = String(secret ?? "").trim();
  const at = text.indexOf(":");
  if (at < 0) return { token: text, bearer: true };
  return { username: text.slice(0, at).trim(), token: text.slice(at + 1).trim() };
}

const credentialOf = credentialFrom;

/**
 * Why this is not a Bitbucket credential, or null when it might be.
 *
 * An app password is a random string with no prefix to check, so the only
 * shape there is to hold is that both halves are there. The username is the
 * one people leave out, because every other host on this page takes a token
 * alone.
 */
export function whyNotAToken(credential) {
  const { username, token, bearer } = credentialOf(credential);
  if (!String(token ?? "").trim()) return "Paste a Bitbucket app password, or an API token.";
  // A grant has no username half by construction, and asking for one would
  // be asking somebody to type what the sign-in already settled.
  if (bearer) return null;
  if (!String(username ?? "").trim()) {
    return "Bitbucket needs the account's username as well - it signs in with both, not with the password alone.";
  }
  return null;
}

const auth = (credential) => {
  const { username, token, bearer } = credentialOf(credential);
  const secret = String(token ?? "").trim();
  const who = String(username ?? "").trim();
  // The API takes both, and which it is is decided by what there is: a
  // grant is a bearer, an app password is Basic with the username.
  if (bearer || !who) return { Authorization: `Bearer ${secret}` };
  return { Authorization: `Basic ${Buffer.from(`${who}:${secret}`, "utf8").toString("base64")}` };
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
 *
 * It needs the username even when the credential is a bearer that does not
 * carry one, so a grant with no username asks Bitbucket who it is first.
 * One extra call, and only for the caller that did not already know - which
 * the cloud does, from the account the connection was verified as.
 */
export async function listMine({ credential, since = Date.now() - 30 * 24 * 60 * 60_000, limit = 100, signal } = {}) {
  const held = credentialOf(credential);
  const username = String(held.username ?? "").trim() || (await verify(credential)).account;
  if (!username) throw new HostError("Bitbucket did not say which account this credential is, so there is nobody to list.", null);
  const query = new URLSearchParams({
    q: `updated_on>=${new Date(since).toISOString()}`,
    sort: "-updated_on",
    pagelen: String(Math.min(50, Math.max(1, limit))),
  });
  for (const state of ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]) query.append("state", state);
  const listed = await ask(`${api()}/2.0/pullrequests/${encodeURIComponent(username)}?${query}`, {
    host,
    headers: auth(credential),
    signal,
  });
  return (listed?.values ?? [])
    .slice(0, limit)
    .map((pull) => shapeOf(pull))
    .filter((pull) => pull.repo && pull.number);
}
