// Identity, verified.
//
// Reuses the Firebase project that already backs codervibes.io, so people sign
// in with the account they already have and there is no second user store to
// keep straight. The browser sends `Authorization: Bearer <idToken>`; this
// verifies it and hands back a trustworthy email.
//
// Three modes, chosen explicitly by CODERVIBES_AUTH:
//
//   firebase  verify every request; refuses to boot without a service account
//   local     the old passwordless cookie, for development only
//   none      there is nobody else: every request is the one person whose
//             laptop this is (edition.js `LOCAL_USER`), and no cookie, header
//             or token is read at all
//
// `firebase` fails closed on purpose. A missing secret in production must stop
// the server, not quietly downgrade it to "type any email you like".
//
// `none` is the local edition's mode and is only safe because of the other
// half of that edition: the server binds to loopback and refuses a request
// that did not come from this machine (edition.js `sameMachine`). Without
// that it is not "no sign-in", it is "sign in as anybody" - which is what
// `local` already is, and why `local` says it is for development.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_USER } from "./edition.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const AUTH_MODE = process.env.CODERVIBES_AUTH ?? "local";
export const isFirebaseAuth = AUTH_MODE === "firebase";

/** Nobody signs in: there is one person, and they are already here. */
export const isNoAuth = AUTH_MODE === "none";

let adminAuth = null;

/** Called once at boot so a misconfiguration is loud and immediate. */
export async function initAuth() {
  if (!isFirebaseAuth) {
    if (AUTH_MODE !== "local" && AUTH_MODE !== "none") {
      throw new Error(
        `Unknown CODERVIBES_AUTH '${AUTH_MODE}'. Expected 'firebase', 'local' or 'none'.`,
      );
    }
    return { mode: AUTH_MODE };
  }

  const credential = loadServiceAccount();
  // firebase-admin v13+ exposes modular entry points; the namespace default
  // export has no `apps` array under ESM.
  const [{ initializeApp, cert, getApps }, { getAuth }] = await Promise.all([
    import("firebase-admin/app"),
    import("firebase-admin/auth"),
  ]);
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: cert(credential) });
  adminAuth = getAuth(app);
  return { mode: "firebase", projectId: credential.project_id };
}

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (err) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${err.message}`);
    }
  }
  const file =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ??
    path.join(here, "..", "firebase-service-account.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `CODERVIBES_AUTH=firebase needs a service account. Set FIREBASE_SERVICE_ACCOUNT ` +
        `(the JSON) or FIREBASE_SERVICE_ACCOUNT_FILE, or put it at ${file}.`,
    );
  }
}

/**
 * Resolve the caller's email from a request, or null when unauthenticated.
 * Throws only on a token that is present but bad, so a signed-out visitor and
 * a forged token are distinguishable.
 */
export async function identify(req) {
  // Nobody to tell apart. The cookie is not read - not even to honour one -
  // because a local installation that took an identity from the request
  // would be a local installation somebody could be somebody else on, and
  // the whole of this mode is that there is only the one person.
  if (isNoAuth) return LOCAL_USER;

  if (!isFirebaseAuth) {
    const cookie = req.headers.cookie ?? "";
    const match = cookie.match(/(?:^|;\s*)cv_user=([^;]+)/);
    return match ? decodeURIComponent(match[1]).trim().toLowerCase() : null;
  }

  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return null;

  const decoded = await adminAuth.verifyIdToken(header.slice(7));
  const email = String(decoded.email ?? "").trim().toLowerCase();
  if (!email) {
    const error = new Error(
      "This account has no email address. Sign in with Google, GitHub, or email instead.",
    );
    error.status = 403;
    throw error;
  }
  if (decoded.firebase?.sign_in_provider === "password" && !decoded.email_verified) {
    const error = new Error("Verify your email address before signing in.");
    error.status = 403;
    throw error;
  }
  return email;
}

/**
 * Detach the GitHub identity from someone's Firebase account.
 *
 * Disconnecting has to do this as well as dropping our stored token, or the
 * GitHub account stays attached to this Firebase user - and re-connecting it
 * anywhere else fails with `credential-already-in-use`, pointing at an account
 * the person thought they had already disconnected.
 *
 * Refuses when GitHub is the only provider on the account: unlinking it would
 * leave a Firebase user nobody can sign in as, which is worse than a link that
 * outlives the token.
 */
export async function unlinkGithub(email) {
  if (!isFirebaseAuth) return { unlinked: false, reason: `${AUTH_MODE} auth mode` };

  const user = await adminAuth.getUserByEmail(email).catch(() => null);
  if (!user) return { unlinked: false, reason: "no such account" };

  const providers = user.providerData.map((entry) => entry.providerId);
  if (!providers.includes("github.com")) {
    return { unlinked: false, reason: "not linked" };
  }
  if (providers.filter((id) => id !== "github.com").length === 0) {
    return {
      unlinked: false,
      reason:
        "GitHub is the only way to sign in to this account, so it stays linked - " +
        "add another sign-in method first.",
    };
  }

  await adminAuth.updateUser(user.uid, { providersToUnlink: ["github.com"] });
  return { unlinked: true };
}

/**
 * How somebody signs in, for their account page.
 *
 * Firebase is the only thing that knows: which providers are attached, when
 * the account was made and when it last signed in are on its user record and
 * nowhere here. The other two modes have none of that - an email in a cookie,
 * or nobody at all - and say so with an empty answer rather than a guess.
 *
 * @returns {Promise<{mode: "firebase"|"local"|"none", providers: string[],
 *                    displayName: string|null, createdAt: string|null,
 *                    lastSignInAt: string|null}>}
 */
export async function describeSignIn(email) {
  const none = { mode: AUTH_MODE, providers: [], displayName: null, createdAt: null, lastSignInAt: null };
  if (!isFirebaseAuth) return none;
  const user = await adminAuth.getUserByEmail(email).catch(() => null);
  if (!user) return none;
  return {
    mode: "firebase",
    providers: user.providerData.map((entry) => entry.providerId),
    displayName: user.displayName ?? null,
    createdAt: user.metadata?.creationTime ?? null,
    lastSignInAt: user.metadata?.lastSignInTime ?? null,
  };
}

/**
 * Remove the sign-in itself - the last step of deleting an account.
 *
 * Last, not first: everything the account owns is deleted before this, so
 * that a failure here leaves a person who can still sign in to an empty
 * account and try again, rather than one locked out of an account that still
 * holds their repos. In local mode there is nothing to delete - the
 * cookie is the sign-in, and the route clears it.
 */
export async function deleteSignIn(email) {
  if (!isFirebaseAuth) return { deleted: false, reason: `${AUTH_MODE} auth mode` };
  const user = await adminAuth.getUserByEmail(email).catch(() => null);
  if (!user) return { deleted: false, reason: "no such account" };
  await adminAuth.deleteUser(user.uid);
  return { deleted: true };
}

// ---------------------------------------------------------------- tickets

/**
 * Browsers cannot set headers on a WebSocket, and putting a bearer token in the
 * query string writes it into every access log and Referer. So the page asks
 * for a ticket over authenticated HTTPS and spends it on connect: short lived,
 * and useless once redeemed.
 *
 * The ticket is *signed* rather than looked up in a table. Production runs more
 * than one machine, and a ticket minted on one used to be unknown to the other,
 * which destroyed the upgrade and made the Shell die on connect roughly half
 * the time. Any machine holding the shared secret can now verify one.
 *
 * Single use is still enforced, but only per machine: a redeemed signature is
 * remembered until it expires. Replaying a ticket on the *other* machine inside
 * its 30s window is therefore possible - which requires already holding the
 * ticket, and so already holding the user's session.
 */
const TICKET_TTL_MS = 30_000;

// All machines must derive the same key. In development there is one process,
// so a per-boot random key is both fine and one less thing to configure.
const TICKET_SECRET = process.env.CODERVIBES_TICKET_SECRET
  ? Buffer.from(process.env.CODERVIBES_TICKET_SECRET, "utf8")
  : randomBytes(32);

const spent = new Map(); // signature -> expiresAt

const sign = (payload) =>
  createHmac("sha256", TICKET_SECRET).update(payload).digest();

export function issueTicket(email) {
  const expiresAt = Date.now() + TICKET_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ email, expiresAt, nonce: randomBytes(12).toString("base64url") }),
  ).toString("base64url");
  return {
    ticket: `${payload}.${sign(payload).toString("base64url")}`,
    expiresInMs: TICKET_TTL_MS,
  };
}

/** Redeem a ticket. Returns the email, or null if forged, stale, or reused. */
export function redeemTicket(ticket) {
  if (!ticket) return null;
  const [payload, signature] = String(ticket).split(".");
  if (!payload || !signature) return null;

  // Constant-time compare, so a timing signal cannot be used to forge one.
  const expected = sign(payload);
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims?.email || typeof claims.expiresAt !== "number") return null;
  if (Date.now() > claims.expiresAt) return null;

  if (spent.has(signature)) return null;
  spent.set(signature, claims.expiresAt);
  return claims.email;
}

/** Forget spent signatures once they could no longer be replayed anyway. */
setInterval(() => {
  const now = Date.now();
  for (const [signature, expiresAt] of spent) {
    if (now > expiresAt) spent.delete(signature);
  }
}, TICKET_TTL_MS).unref();
