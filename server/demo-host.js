// The hostname the demo answers on its own.
//
// The demo is reachable at `/activity` on the main site and always has
// been, but that is not a link anybody wants to hand out: it says nothing
// about what it opens, and it is one press of the rail away from a console
// that asks the reader to sign in. A hostname of its own says what it is
// before it loads, and every page under it is the demo.
//
// Which hostname: `CODERVIBES_DEMO_HOST` when it is set, and otherwise
// `demo.` in front of whatever `CODERVIBES_PUBLIC_URL` says this
// installation is. Derived rather than required, so an installation that
// points a `demo.` record at this app gets the behaviour by doing the DNS
// and nothing else - and an installation that does not is unaffected,
// because a hostname nobody can resolve is a hostname no request arrives
// on. Set it to an empty string to turn the whole thing off.
//
// The request's own host is what decides, not the configured origin:
// `publicOrigin` deliberately answers the *configured* address for the
// links it builds (an invitation, an MCP URL), and that is exactly the
// wrong answer here, where the question is which door this reader came
// through. The old repo router read `req.headers.host` on Fly to map a
// hostname to a sandbox and it worked, so the proxy passes it through;
// `x-forwarded-host` is preferred where something else put one there.

/** The configured demo hostname, lowercased and without a port, or null when off. */
export function demoHostname() {
  const set = process.env.CODERVIBES_DEMO_HOST;
  if (set !== undefined) return clean(set) || null;
  const origin = process.env.CODERVIBES_PUBLIC_URL ?? "";
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  // Not `demo.demo.example`: an installation already served from the demo
  // hostname needs no second one.
  return host && !host.startsWith("demo.") ? `demo.${host}` : null;
}

/** The host this request came in on, as the browser asked for it. */
export function hostOf(req) {
  const forwarded = String(req?.headers?.["x-forwarded-host"] ?? "").split(",")[0];
  return clean(forwarded || req?.headers?.host || "");
}

/** Whether this request arrived on the demo's own hostname. */
export function isDemoHost(req) {
  const wanted = demoHostname();
  return Boolean(wanted) && hostOf(req) === wanted;
}

/** Lowercase, no port, no stray spaces - what two hostnames have to agree on. */
function clean(value) {
  return String(value ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}
