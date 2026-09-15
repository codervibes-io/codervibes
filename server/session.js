// Per-request authorisation.
//
// Who the caller is comes from auth.js - a verified Firebase token in
// `firebase` mode, or the old cookie in `local` mode. This module only decides
// what that person may do with the repo they have selected.
import { repos } from "./repos.js";
import { demoHostname, isDemoHost } from "./demo-host.js";
import { workspaces } from "./workspaces.js";
import { identify, isFirebaseAuth } from "./auth.js";

export const USER_COOKIE = "cv_user";
export const REPO_COOKIE = "cv_repo";
export const WORKSPACE_COOKIE = "cv_workspace";

export function parseCookies(header) {
  const jar = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    jar[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function setCookie(res, name, value, { maxAge = 60 * 60 * 24 * 365 } = {}) {
  res.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
  );
}

/**
 * Which workspace this person has open: the one their cookie names, if
 * they are still in it, else their personal one - made now if they have
 * none yet, which is what makes a first sign-in land somewhere. A cookie
 * naming a workspace this process has not heard of is re-read once before
 * being disbelieved, for the same reason as a repo below.
 *
 * Null for a signed-out caller: there is nothing to scope.
 */
async function resolveWorkspace(cookies, user, { demoHost = false } = {}) {
  await workspaces.load();
  const requested = cookies[WORKSPACE_COOKIE];
  // On the demo's own hostname the demo is what this app is, for everybody.
  // Signed in too: the point of handing somebody demo.<host> is that they
  // see the demo, and a reader who happens to have an account here would
  // otherwise follow that link into their own workspace and wonder what
  // they had been sent. Nothing is loosened - the demo is the room a
  // visitor with no account may already read, and a member of it is still
  // nobody, so every write asks a grant that is not there.
  if (demoHost) {
    const demo = workspaces.demo();
    if (demo) return workspaces.describe(demo, user);
  }
  // Signed out lands in the demo, when this installation has one and it
  // lives here. It is the only room reachable without an account, and what
  // makes it safe is not a check here but the absence of a grant: every
  // write asks `permits`, and a caller with no address holds nothing
  // (repos.js `permissionsFor`). Null when nothing has been seeded, and the
  // console shows the gate. Null, too, on the main site of an installation
  // whose demo has a hostname of its own: the demo is reachable there and
  // only there, so that signing out of the console lands on the pitch
  // rather than on a stranger's month of work at the same address, and so
  // the demo is one thing with one address rather than a thing that is
  // also every console address a visitor happens to type.
  if (!user) {
    const demo = demoReachable(demoHost) ? workspaces.demo() : null;
    return demo ? workspaces.describe(demo, null) : null;
  }
  const listing = { demo: demoReachable(demoHost) };
  let mine = workspaces.listFor(user, listing);
  if (requested && !mine.some((workspace) => workspace.id === requested)) {
    await workspaces.refresh();
    mine = workspaces.listFor(user, listing);
  }
  const chosen = mine.find((workspace) => workspace.id === requested);
  if (chosen) return chosen;
  const personal = await workspaces.personalOf(user);
  return workspaces.describe(personal, user);
}

/**
 * Resolve who is asking, which workspace they have open, which repo in it
 * they're pointed at, and what they may do there. Attached to every request
 * as `req.cv`.
 *
 * Everything below the workspace is scoped by it: `available` is the repos
 * in that workspace, and a repo cookie pointing outside it is ignored rather
 * than followed - switching workspaces is meant to change what you see.
 */
export async function resolveSession(cookies, user = null, { demoHost = false } = {}) {
  await repos.load();
  const workspace = await resolveWorkspace(cookies, user, { demoHost });

  const scope = { workspace: workspace?.id ?? null };

  // Signed out is no longer nothing to see. There used to be a throwaway
  // in-memory repo here - one prompt, nothing that runs, nothing persisted -
  // so a visitor could try the editor without an account; there is no editor
  // to try, and for a while after that a visitor got the sign-in form and a
  // page of prose. A console with no work in it demonstrates nothing, which
  // was the objection then and is still true - so what a visitor gets now is
  // the demo workspace, full of a month of somebody's work, resolved above.
  // `listFor` scopes it the same way it scopes everybody: to the one
  // workspace they can see.
  let available = repos.listFor(user, scope);
  const requested = cookies[REPO_COOKIE];

  // The caller is pointed at a repo this process has never heard of.
  // Usually that means another machine just created it, so re-read the store
  // before concluding it does not exist - silently opening a different
  // repo is far worse than one extra read.
  if (requested && !available.some((repo) => repo.id === requested)) {
    await repos.refresh();
    available = repos.listFor(user, scope);
  }

  const chosen =
    available.find((repo) => repo.id === requested) ?? available[0] ?? null;

  if (!chosen) {
    return { user, workspace, repo: null, permissions: [], available };
  }

  // No `root`: a repo used to be a directory on a machine this app booted,
  // and this said which. There is no directory and no machine.
  return { user, workspace, repo: chosen, permissions: chosen.permissions, available };
}

export function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const demoHost = isDemoHost(req);
  identify(req)
    .then((user) => resolveSession(cookies, user, { demoHost }))
    .then((session) => {
      // Carried on the request so the routes and the console can say so:
      // the page that opens here is the demo rather than the pitch, and the
      // way to an account is the main site.
      req.cv = { ...session, demoHost };
      next();
    })
    .catch((err) => {
      // A bad token is a 401, not a 500 - the browser should re-authenticate
      // rather than treat it as a server fault.
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(401).json({ error: "Sign in again", detail: err.message });
    });
}

/** Routes that require a signed-in user, regardless of repo capability. */
export function requireUser(req, res, next) {
  if (!req.cv?.user) {
    // `signInRequired` is what turns a 401 into the sign-in dialog rather than
    // a red toast - the browser cannot tell the two apart from the status.
    return res
      .status(401)
      .json({ error: "Sign in to continue", signInRequired: true });
  }
  next();
}

/**
 * Routes that only read.
 *
 * A visitor with no account gets through when they have landed somewhere -
 * which, for a visitor, is only ever the demo workspace (`resolveWorkspace`).
 * Everything below this reads through the open workspace, so letting them
 * past widens what is readable by exactly that one room and nothing else.
 * Writes keep `requireUser`, and would refuse them for want of a grant even
 * if they did not.
 */
export function requireViewer(req, res, next) {
  if (!req.cv?.user && !req.cv?.workspace) {
    return res
      .status(401)
      .json({ error: "Sign in to continue", signInRequired: true });
  }
  next();
}

/** Whether this request is somebody reading the demo without an account. */
export const isVisitor = (req) => !req.cv?.user && Boolean(req.cv?.workspace);

/**
 * Whether the demo is reachable through the door this request came in by.
 *
 * On an installation whose demo has a hostname of its own (demo-host.js)
 * the demo answers there and nowhere else - not as a workspace on the main
 * site's switcher, not as what a signed-out console address opens. Where
 * there is no such hostname the demo is a workspace like any other public
 * one, on every switcher and at every console address for a visitor.
 *
 * `demoHost` is the request's own, as `sessionMiddleware` worked it out;
 * `demoReachableFor(req)` is the same question asked of a request.
 */
export const demoReachable = (demoHost) => !demoHostname() || Boolean(demoHost);
export const demoReachableFor = (req) => demoReachable(req.cv?.demoHost);

/** Who a record belongs to. Only ever "local" in local auth mode. */
export const identityOf = (req) => req.cv?.user ?? "local";
