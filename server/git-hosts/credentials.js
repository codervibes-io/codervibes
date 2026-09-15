// Where one person's git host tokens are kept, on this machine.
//
// A field on the owner's row (user-record.js), beside the ingest token and
// for the same reasons: it is small, it is read by nobody but its owner,
// and a second table would be a second thing to create before anybody can
// paste a token. The shape is one entry per host:
//
//   gitHosts: { gitlab: { credential: "<encrypted JSON>", account, at } }
//
// **The token is encrypted at rest** (crypto-at-rest.js), the same cipher
// the ingest token and the connector credentials use - and, exactly as
// there, `CODERVIBES_TOKEN_SECRET` is what makes that true. Without it the
// cipher is a pass-through and the token is plaintext in a JSON file in the
// data directory. On a laptop that is the honest trade and not a hole: the
// file sits in the person's own home directory, on the machine that already
// holds the git credentials this token stands in for, and anybody who can
// read it can read `~/.git-credentials` too. An installation with other
// people's rows in it sets the secret.
//
// Nothing here knows any vendor's dialect, and nothing in the three host
// modules knows this file exists. That is the seam: the cloud's version of
// this - rows in connectors/store.js, an OAuth grant rather than a pasted
// token - is another object with the same four functions, handed to sync.js
// and to the routes in its place.
import { decrypt, encrypt } from "../crypto-at-rest.js";
import { field, patch } from "../user-record.js";
import { HostError, hostOrRefuse } from "./index.js";

const FIELD = "gitHosts";

/** Everything the row holds, or an empty map. */
const allFor = async (user) => (user ? await field(user, FIELD, {}) : {});

/**
 * Connect a host: check the credential with the host first, keep it after.
 *
 * In that order on purpose. A token that is kept and then found not to work
 * is a page that says "connected" over a sweep that fails silently every
 * five minutes, and the person has no reason to look. Asking first means
 * the refusal reaches the form the token was pasted into, which is the one
 * place somebody can do anything about it.
 *
 * @returns {Promise<{host: string, account: string|null, at: string}>}
 */
export async function connect(user, host, credential) {
  if (!user) throw new HostError("A git host is connected by somebody.", 400);
  const module = hostOrRefuse(host);
  const why = module.whyNotAToken(credential);
  if (why) throw new HostError(why, 400);
  const { account } = await module.verify(credential);
  const entry = { credential: encrypt(JSON.stringify(credential)), account: account ?? null, at: new Date().toISOString() };
  await patch(user, { [FIELD]: { ...(await allFor(user)), [module.id]: entry } });
  return { host: module.id, account: entry.account, at: entry.at };
}

/**
 * Forget a host's token. Says whether there was one.
 *
 * What it does not do is unpick the records: the pull requests the sweep
 * already folded are what happened, and they stay. Disconnecting stops the
 * asking, which is the thing a person is asking for.
 */
export async function disconnect(user, host) {
  const module = hostOrRefuse(host);
  const all = await allFor(user);
  if (!(module.id in all)) return false;
  const next = { ...all };
  delete next[module.id];
  await patch(user, { [FIELD]: next });
  return true;
}

/** The same question, asked of a host this app may no longer know. */
const hostOrRefuseQuietly = (host) => {
  try {
    return hostOrRefuse(host);
  } catch {
    return null;
  }
};

/**
 * What this person has connected: the host, the account it is, and when.
 *
 * Never the credential. This is what the page reads and what the sweep
 * iterates, and a token that is not in the answer is a token that cannot
 * reach a browser by anybody's mistake.
 */
export async function listFor(user) {
  const all = await allFor(user);
  return Object.entries(all)
    .filter(([host]) => hostOrRefuseQuietly(host))
    .map(([host, entry]) => ({ host, account: entry?.account ?? null, at: entry?.at ?? null }));
}

/**
 * The credential itself, for the one caller that has to have it.
 *
 * Null when the host is not connected, and null when it was encrypted under
 * a secret this process no longer has - the sweep then skips that host,
 * which is better than a crash on a timer. Adding the token again is the
 * fix, and the page is where that is done.
 */
export async function credentialFor(user, host) {
  const entry = (await allFor(user))[String(host ?? "").toLowerCase()];
  if (!entry?.credential) return null;
  try {
    return JSON.parse(decrypt(entry.credential));
  } catch {
    return null;
  }
}

/** Whether this person has any host connected at all - what decides if a sweep has anything to do. */
export const anyFor = async (user) => (await listFor(user)).length > 0;
