// Encrypting somebody else's credential before it touches a disk.
//
// Both stores encrypt at the storage layer already; this is defence against
// the row itself leaking, which matters more here than usual - a Slack bot
// token posts as you, a Linear key files tickets as you, and a GitHub `repo`
// scope is read *and* write.
//
// It lives here rather than in connectors/store.js, where it was written,
// because secrets.js needs exactly the same thing and a second copy of a
// cipher is a second place to get an IV wrong.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const SECRET = process.env.CODERVIBES_TOKEN_SECRET;

/**
 * The salt is the old one on purpose.
 *
 * GitHub tokens were stored by github-identity.js under this exact string, and
 * changing it would turn every token already on disk into undecryptable
 * nonsense - the failure mode being everybody silently losing their GitHub
 * connection on deploy, with no error that says why. It reads oddly now that
 * this file is not about GitHub or identities; it is still the right string.
 */
const key = SECRET ? scryptSync(SECRET, "codervibes-github-identity", 32) : null;

export const canEncrypt = () => Boolean(key);

export class SecretError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function encrypt(plaintext) {
  if (!key) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(":");
}

export function decrypt(stored) {
  if (!String(stored ?? "").startsWith("v1:")) return stored; // written before a secret existed
  if (!key) {
    throw new SecretError(
      "This was stored encrypted but CODERVIBES_TOKEN_SECRET is not set. Set it " +
        "to the value it was saved with, or delete it and add it again.",
      500,
    );
  }
  const [, iv, tag, body] = String(stored).split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
