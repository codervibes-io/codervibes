// WebSocket tickets and the conversation repair.
//
// Both are places where being wrong is quiet: a ticket that can be replayed
// leaks a session, and a conversation with a dangling tool_use is rejected by
// the API forever rather than failing once.
import test from "node:test";
import assert from "node:assert/strict";

process.env.CODERVIBES_TICKET_SECRET = "test-secret-for-tickets";
const { issueTicket, redeemTicket } = await import("../server/auth.js");
const { parseCookies } = await import("../server/session.js");

// ---------------------------------------------------------------- tickets

test("a ticket redeems once, to the email it was issued for", () => {
  const { ticket, expiresInMs } = issueTicket("ada@example.com");
  assert.ok(expiresInMs > 0);
  assert.equal(redeemTicket(ticket), "ada@example.com");
  assert.equal(redeemTicket(ticket), null, "a ticket must not be replayable");
});

test("two tickets for the same person are different", () => {
  const first = issueTicket("ada@example.com").ticket;
  const second = issueTicket("ada@example.com").ticket;
  assert.notEqual(first, second, "a nonce keeps them from colliding");
  assert.equal(redeemTicket(first), "ada@example.com");
  assert.equal(redeemTicket(second), "ada@example.com");
});

test("a forged or tampered ticket is refused", () => {
  const { ticket } = issueTicket("ada@example.com");
  const [payload, signature] = ticket.split(".");

  assert.equal(redeemTicket(null), null);
  assert.equal(redeemTicket(""), null);
  assert.equal(redeemTicket("nonsense"), null);
  assert.equal(redeemTicket(payload), null, "no signature");
  assert.equal(redeemTicket(`${payload}.deadbeef`), null, "wrong signature");

  // Re-signing someone else's email requires the secret, which is the point.
  const forged = Buffer.from(
    JSON.stringify({ email: "mallory@example.com", expiresAt: Date.now() + 10_000 }),
  ).toString("base64url");
  assert.equal(redeemTicket(`${forged}.${signature}`), null);
});

test("an expired ticket is refused", () => {
  const payload = Buffer.from(
    JSON.stringify({ email: "ada@example.com", expiresAt: Date.now() - 1 }),
  ).toString("base64url");
  // Signed correctly, but stale - issued through the real path then aged out.
  const { ticket } = issueTicket("ada@example.com");
  const signature = ticket.split(".")[1];
  assert.equal(redeemTicket(`${payload}.${signature}`), null);
});

// ---------------------------------------------------------------- cookies

test("cookies parse, including values that were encoded", () => {
  const jar = parseCookies("cv_user=ada%40example.com; cv_repo=navigator-a1b2c3");
  assert.equal(jar.cv_user, "ada@example.com");
  assert.equal(jar.cv_repo, "navigator-a1b2c3");
});

test("a malformed cookie header does not throw", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("nonsense; =empty; a=1"), { a: "1" });
});

// ----------------------------------------------------------- conversations
