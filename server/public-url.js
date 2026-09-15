// The address this installation is reached at.
//
// Behind the Fly proxy `req.get("host")` is the internal hostname, and
// everything built from this is somewhere a wrong address cannot be shrugged
// off: an invitation email, the MCP URL an agent is given, the command that
// pairs somebody's laptop, and now the base URL a resident agent is told to
// send its model calls to. So the public origin is configured, and the request
// is only the fallback for local runs.
//
// Its own module because more than one thing needs it and the alternative was
// a second copy - and two answers to "where are we" is how an agent ends up
// pointed at the wrong installation.
export function publicOrigin(req) {
  const origin = (process.env.CODERVIBES_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (origin) return origin;
  if (!req) return null;
  return `${req.protocol}://${req.get("host")}`;
}
