// What is different about a CoderVibes that runs on one person's laptop.
//
// The hosted product and the local edition are the same program. The local
// edition is a strict subset of it: one person, their own machine, their own
// disk, four pages, and no sign-in - and the way to keep it a subset rather
// than a fork is to have every difference be a value read from one place,
// so that a reader can see the whole of what "local" means without grepping
// the server for it. That is this module.
//
// Three differences, and they are all here:
//
//   who      there is nobody to sign in as, so the owner of everything is
//            the account on the machine. `LOCAL_USER` is that name in the
//            email shape the rest of the app already expects an owner to
//            have, because a dozen modules read an owner as one - they
//            split it, lowercase it, key rows on it, put it in a mail link.
//            A bare username would be a subtle wrongness in all of them.
//
//   how many the hosted product bounds nothing per account beyond what the
//            store can hold; the local edition seats three executors,
//            because it is one laptop's worth of agents and because a
//            number the person can see is a number they can reason about.
//            `MAX_EXECUTORS` is `Infinity` unless the entry sets the
//            environment variable, so the full product is unchanged by
//            this file existing.
//
//   from     no sign-in means nothing stands between the network and the
//   where    whole console, so the local edition must not be on the
//            network at all. `isLoopback` and `sameMachine` are that rule,
//            enforced per request rather than only at bind time: binding
//            to 127.0.0.1 is the first half, and a person who puts ngrok,
//            Tailscale Funnel or an nginx `proxy_pass` in front of a
//            loopback server has undone it without touching this app's
//            configuration. The socket's own peer address is the one fact
//            such a proxy cannot forge - it is the proxy's own connection -
//            so that, and never a header, is what is read. A refusal is
//            logged: it means something is in front of this that should
//            not be, and that is worth a line in the terminal the person
//            started it in.
import os from "node:os";

/**
 * The one account on a local installation.
 *
 * Lowercased, because every owner in this app is - `identify` lowercases
 * the email it verifies, and a row keyed by `Ada@localhost` would be a
 * second person from the same laptop. The fallback is for a machine whose
 * passwd entry cannot be read (a container with no user record): a name
 * nobody chose is better than a boot that fails over who you are.
 */
export const LOCAL_USER = (() => {
  try {
    const name = String(os.userInfo().username ?? "").trim().toLowerCase();
    return name ? `${name}@localhost` : "local@localhost";
  } catch {
    return "local@localhost";
  }
})();

/**
 * How many executors one account may register.
 *
 * `Infinity` unless `CODERVIBES_MAX_EXECUTORS` says otherwise, so the
 * hosted product is exactly what it was; the local entry sets it. Anything
 * that is not a positive whole number is ignored rather than taken as
 * zero - a typo in an environment variable must not be a server that
 * refuses every machine.
 */
export const MAX_EXECUTORS = (() => {
  const said = Number(process.env.CODERVIBES_MAX_EXECUTORS);
  return Number.isInteger(said) && said > 0 ? said : Infinity;
})();

/**
 * Whether an address is this machine talking to itself: `127.0.0.0/8`,
 * `::1`, or a v4 loopback address wearing IPv6's `::ffff:` clothes, which
 * is what Node hands back on a dual-stack socket.
 *
 * Nothing else, and an absent address is false: a socket with no peer
 * address is a case this does not understand, and the safe reading of one
 * it does not understand is "not from here".
 */
export function isLoopback(address) {
  const said = String(address ?? "").trim().toLowerCase();
  if (!said) return false;
  if (said === "::1") return true;
  // A v4 address mapped into v6, which is how `127.0.0.1` arrives on a
  // socket that was opened for both families.
  const v4 = said.startsWith("::ffff:") ? said.slice("::ffff:".length) : said;
  const parts = v4.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return parts[0] === "127";
}

/** What a request from anywhere else is told. */
export const NOT_THIS_MACHINE = "This CoderVibes answers only on this machine.";

/**
 * Express middleware: only this machine may ask.
 *
 * Read off the socket, not off `X-Forwarded-For` or `req.ip` - a header is
 * written by whatever is in front, which in the case this defends against
 * is exactly the thing that should not be there.
 */
export function sameMachine(req, res, next) {
  const address = req.socket?.remoteAddress;
  if (isLoopback(address)) return next();
  console.warn(
    `refused a request from ${address ?? "an address the socket did not name"}: ` +
      `this CoderVibes has no sign-in, so it answers on this machine only. ` +
      `Something is forwarding to it from off the machine.`,
  );
  return res.status(403).json({ error: NOT_THIS_MACHINE });
}

/**
 * Whether this installation has connected services at all.
 *
 * The local edition has none by construction: there is nobody to connect
 * them as, and `server/connectors/` is not in the code it ships. Every
 * module that wants the connector store already asks for it with a dynamic
 * import, so that an installation without one does not pay for it - but
 * "lazily" is not the same as "only when there is one". repos.js took that
 * import on every load, for a migration that has nothing to read without
 * connectors; on a laptop that was not a missing feature but every request
 * answered 500 for a module the edition is right not to have, with the
 * reason four frames deep in a message about repos.
 *
 * Read per call rather than once at import, because it is the environment
 * the entry point settles and a test may settle it differently.
 */
export const hasConnectors = () => String(process.env.CODERVIBES_AUTH ?? "").trim().toLowerCase() !== "none";
