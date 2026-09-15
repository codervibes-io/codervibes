// Three git hosts, one contract, and no installation behind any of them.
//
// A person opens pull requests on GitHub, GitLab or Bitbucket, and what
// this app is for is saying what became of them: merged, closed, or still
// waiting. The hosted product learns that from a GitHub App - a webhook,
// an installation, a person signing in - and none of that is available to
// somebody running this on their laptop, or to a team whose repositories
// live on a GitLab they cannot install anything on. What *is* available to
// both is a personal access token, which is the whole of what this module
// takes.
//
// **Why it is not under connectors/.** A connector is a service an agent is
// lent - a tool it may call, a credential the installation holds, a
// permission somebody granted. This is not that: nothing here is offered to
// an agent, nothing writes, and the only thing read is the person's own
// pull requests. It is also the half the local edition needs, and
// `connectors/` is on that edition's deny list whole
// (scripts/lib/closure.mjs) - so a git host under it could not be carried
// into the cut without taking the rest of the connector machinery with it.
//
// **What is separable, and why.** Two seams, because the cloud will need
// both halves in different places:
//
//   - a *host* (github.js, gitlab.js, bitbucket.js) knows one vendor's
//     dialect and nothing about where a token is kept. It is handed a
//     credential and answers in the one normalised pull shape below.
//   - a *credentials* object (`{ listFor, credentialFor }`) knows where a
//     person's tokens are and nothing about any vendor. credentials.js is
//     the local edition's - a field on the owner's row - and the cloud's
//     will be one backed by connectors/store.js, handed to the same
//     sync.js and the same routes.
//
// The normalised shape every host answers in, which is repo-sources/github.js
// `pullShape` plus the two things a second host makes necessary:
//
//   { host, repo, number, title, url, state: "open"|"merged"|"closed",
//     headRef, baseRef, mergeCommitSha, author: {login, bot}, draft,
//     openedAt, updatedAt, mergedAt, closedAt,
//     additions, deletions, changedFiles, mentions, reverts }
//
// `host` because a record has to say which of the three it is, and `repo`
// because a host that lists a person's pull requests across repositories
// has to say which repository each was on.
import * as github from "./github.js";
import * as gitlab from "./gitlab.js";
import * as bitbucket from "./bitbucket.js";
import { HostError } from "./http.js";

export { HostError } from "./http.js";

/** The three, by the name a record and a URL use. */
export const HOSTS = { github, gitlab, bitbucket };

/** Every host, in the order a page offers them. */
export const ALL = [github, gitlab, bitbucket];

/** The host a name is, or null for one this app does not know. */
export const hostNamed = (name) => HOSTS[String(name ?? "").trim().toLowerCase()] ?? null;

/** The default, and what every record written before there was a choice is. */
export const DEFAULT_HOST = "github";

/**
 * Which host a web address is on, or null.
 *
 * By the hostname's tail, so `gitlab.example.com` is a GitLab - a
 * self-hosted instance is still that host's dialect, and the API it answers
 * is set by the environment rather than guessed from the name.
 */
export function hostOf(url) {
  const text = String(url ?? "").trim().toLowerCase();
  const found = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/.exec(text)?.[1] ?? text.split("/")[0];
  if (!found) return null;
  if (found === "github.com" || found.endsWith(".github.com")) return "github";
  if (found === "gitlab.com" || found.includes("gitlab.")) return "gitlab";
  if (found === "bitbucket.org" || found.includes("bitbucket.")) return "bitbucket";
  return null;
}

/** The three remote spellings git uses, whichever host it is. */
const REMOTE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|(?:[^@\s]+@)?([^/:\s]+):)(.+?)(?:\.git)?\/?$/i;

/**
 * The host and the repository a git remote names, or null.
 *
 * `https://github.com/ada/engine.git`, `git@gitlab.com:ada/team/engine.git`,
 * `ssh://git@bitbucket.org/ada/engine`, and a bare `ada/engine`, which is
 * GitHub because that is what it has always meant here.
 *
 * The path is kept whole. A GitLab project can sit several groups deep -
 * `platform/infra/engine` is one project, not a project in a namespace to
 * be trimmed - and shortening it to the last two segments would make two
 * different projects the same record. GitHub and Bitbucket are two segments
 * by construction, so keeping the path costs them nothing.
 *
 * A remote on a host this app does not know is null rather than a guess:
 * the session stays unlinked, which is what it has always done, rather than
 * being linked to the wrong thing.
 */
export function parseRemote(remote) {
  const text = String(remote ?? "").trim();
  if (!text) return null;
  const match = REMOTE.exec(text);
  if (match) {
    const host = hostOf(match[1] ?? match[2] ?? "");
    const fullName = String(match[3] ?? "").replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    if (!host || !fullName.includes("/")) return null;
    return { host, fullName };
  }
  // `owner/name` on its own: what a hook reports when the checkout's remote
  // was already shortened, and GitHub by long-standing default.
  return /^[\w.-]+\/[\w.-]+$/.test(text) ? { host: DEFAULT_HOST, fullName: text } : null;
}

/**
 * Where a pull request is on the web, for a record made from a URL-less
 * source. Each host writes its own path, and GitLab's carries the `-`
 * segment that separates a project's path from the thing being asked for.
 */
export function pullUrlOf(host, fullName, number) {
  const name = String(fullName ?? "");
  const at = Number(number);
  if (!name || !at) return null;
  if (host === "gitlab") return `${gitlab.web}/${name}/-/merge_requests/${at}`;
  if (host === "bitbucket") return `${bitbucket.web}/${name}/pull-requests/${at}`;
  return `${github.web}/${name}/pull/${at}`;
}

/** What one host calls a pull request, for a sentence a person reads. */
export const pullWord = (host) => (host === "gitlab" ? "merge request" : "pull request");

/**
 * What a host is, to a page: everything but the credential.
 *
 * Never the token, and not only because nothing needs it in a browser: the
 * one way a token cannot leak through an answer is for no answer to have a
 * shape it could sit in.
 */
export const describeHost = (host, connection = null) => ({
  host: host.id,
  label: host.label,
  web: host.web,
  hint: host.hint,
  // Bitbucket signs in with two halves, so the form that connects it has
  // two boxes. Said by the host rather than decided in the browser.
  needsUsername: host.id === "bitbucket",
  connected: Boolean(connection),
  account: connection?.account ?? null,
  at: connection?.at ?? null,
});

/** The host a name is, or a HostError a route can answer 404 with. */
export function hostOrRefuse(name) {
  const host = hostNamed(name);
  if (!host) throw new HostError(`This app knows GitHub, GitLab and Bitbucket, and not "${name}".`, 404);
  return host;
}
