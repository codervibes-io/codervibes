// Asking the hosts what became of the work, on a clock.
//
// This is pull-poll.js's job for an installation that has no App and no
// webhook: nothing is ever delivered here, so the only way a merge is ever
// learnt is by asking. What it asks is the narrowest question there is -
// "my own pull requests, updated since" - which is one call per host per
// sweep and says nothing about anybody else's repositories.
//
// What it does with the answer is the fold every other ear uses
// (pulls.apply), through an event shaped exactly like the one a webhook
// would have delivered. That is the whole point: a merge learnt here is
// indistinguishable downstream from one that was delivered, so the session's
// outcome flips to merged and Performance counts it without a second code
// path existing anywhere.
//
// The link back to a session is the branch. A session says which branch its
// checkout was on (telemetry-ingest.js), a pull request says which branch it
// came from, and `pulls.link` joins the two by repository and head ref - so
// nobody has to have told this app anything at the moment the pull request
// was opened, which on a laptop is exactly what happens.
//
// Handed its credentials rather than importing them: credentials.js is the
// local edition's store, and the cloud's is a connectors-backed object with
// the same two functions. See index.js.
import * as pulls from "../pulls.js";
import { DEFAULT_HOST, hostNamed } from "./index.js";
import * as localCredentials from "./credentials.js";

/** How often the connected hosts are asked. The same five minutes pull-poll.js uses. */
export const EVERY_MS = 5 * 60_000;
/** How far back a sweep asks. A month: the window every other listing here uses. */
export const SINCE_MS = 30 * 24 * 60 * 60_000;
/** How many pull requests one host gives up per sweep. */
export const PER_HOST = 100;

/**
 * What a host said, in the shape of the event a webhook would have
 * delivered. `polled: true` so a listener that cares which ear heard it
 * still can; `host` so the fold files it under the right one.
 */
export function asEvent(pull) {
  return {
    kind: "pull",
    polled: true,
    host: pull.host ?? DEFAULT_HOST,
    repo: pull.repo,
    number: Number(pull.number),
    title: pull.title ?? null,
    url: pull.url ?? null,
    headRef: pull.headRef ?? null,
    baseRef: pull.baseRef ?? null,
    mergeCommitSha: pull.mergeCommitSha ?? null,
    // Numbers, never the words they were read out of - the description
    // stops at the host module, which is where it already was.
    mentions: pull.mentions ?? [],
    reverts: pull.reverts ?? null,
    author: pull.author ?? null,
    draft: Boolean(pull.draft),
    state: pull.state ?? "open",
    openedAt: pull.openedAt ?? null,
    mergedAt: pull.mergedAt ?? null,
    closedAt: pull.closedAt ?? null,
    additions: pull.additions ?? null,
    deletions: pull.deletions ?? null,
    changedFiles: pull.changedFiles ?? null,
  };
}

/**
 * Ask one host about one record and fold the answer.
 *
 * The record as it now stands, or null when the host is not connected, has
 * nothing to say, or refuses - all three leave the record exactly as it
 * was, and the next sweep tries again.
 *
 * @param {object} record a pull record (or anything with host, repo, number)
 * @param {object} args
 * @param {string} args.user whose credential to ask with
 * @param {{credentialFor: Function}} [args.credentials]
 */
export async function refreshPull(record, { user, credentials = localCredentials } = {}) {
  const host = hostNamed(record?.host ?? DEFAULT_HOST);
  if (!host || !record?.repo || !Number(record?.number) || !user) return null;
  const credential = await credentials.credentialFor(user, host.id).catch(() => null);
  if (!credential) return null;
  const described = await host
    .describePull({ fullName: record.repo, number: Number(record.number), credential })
    .catch(() => null);
  if (!described) return null;
  const folded = await pulls.apply(asEvent(described));
  return folded?.pull ?? null;
}

/**
 * Every host this person has connected, asked for their own pull requests
 * and folded.
 *
 * One failure is one host's: a GitLab whose token expired must not stop the
 * GitHub half of the same sweep. It is logged once for the host rather than
 * once per pull request, because a host that is refusing is refusing every
 * call and a hundred identical lines in a terminal is a log nobody reads.
 *
 * @returns {Promise<{hosts: number, seen: number, changed: number, failed: string[]}>}
 */
export async function sweep(user, { credentials = localCredentials, since = Date.now() - SINCE_MS, limit = PER_HOST } = {}) {
  const out = { hosts: 0, seen: 0, changed: 0, failed: [] };
  if (!user) return out;
  const connected = await credentials.listFor(user).catch(() => []);
  for (const { host: name } of connected) {
    const host = hostNamed(name);
    if (!host) continue;
    out.hosts += 1;
    try {
      const credential = await credentials.credentialFor(user, host.id);
      if (!credential) continue;
      const mine = await host.listMine({ credential, since, limit });
      for (const pull of mine) {
        if (!pull?.repo || !Number(pull.number)) continue;
        out.seen += 1;
        // Never fatal for the rest of the host's pull requests: one record
        // that will not fold is one record.
        const folded = await pulls.apply(asEvent(pull)).catch((err) => {
          console.warn(`git-hosts: could not fold ${host.id} ${pull.repo}#${pull.number}: ${err.message}`);
          return null;
        });
        if (folded?.changed) out.changed += 1;
      }
    } catch (err) {
      out.failed.push(host.id);
      console.warn(`git-hosts: ${host.label} could not be swept: ${err.message}`);
    }
  }
  return out;
}

/**
 * Sweep on a clock, for everybody who has a host connected.
 *
 * Nothing reaches the network until somebody connects one: a tick with no
 * connected host asks nobody anything, and the timer itself is unref'd, so
 * a laptop with the lid shut is a process doing nothing rather than a
 * process retrying something. That is the local edition's rule (local.js),
 * and it is the reason this is a sweep over `users()` rather than a timer
 * started when a token is pasted - a timer per connection is a timer to
 * cancel, and the thing being cancelled is one condition to read.
 *
 * The first sweep is soon after boot rather than at it: the process that
 * has just started knows nothing of what merged overnight, and it is called
 * while the module graph is still being built.
 *
 * @returns {() => void} the stop, for tests
 */
export function start({ users = () => [], credentials = localCredentials, everyMs = EVERY_MS, sweepAfterMs = 20_000 } = {}) {
  const round = async () => {
    for (const user of users()) {
      await sweep(user, { credentials }).catch((err) => console.warn(`git-hosts: sweeping ${user}: ${err.message}`));
    }
  };
  const timer = setInterval(() => {
    round().catch(() => {});
  }, everyMs);
  timer.unref?.();
  const first = sweepAfterMs == null ? null : setTimeout(() => {
    round().catch(() => {});
  }, sweepAfterMs);
  first?.unref?.();
  return () => {
    clearInterval(timer);
    if (first) clearTimeout(first);
  };
}
