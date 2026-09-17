// Which parts of the product this installation actually has.
//
// The hosted console and the local edition (`npm run local`) are the same
// page modules - that is the whole design, and server/edition.js says why on
// the other side of the wire. But the same modules were saying the same
// words, and half the words are about things a laptop has none of: an
// Adoption ladder that ranks a team, a column for who invited an agent, a
// Sandbox to compare places to run, an access trail of who did what under
// which permission, a Connectors panel offering to lend services an agent
// can call. On one person's machine each of those is a heading over a dash,
// and a dash is not "none of that happened" - it reads as "this is broken",
// or worse, as a feature to go looking for.
//
// So this is the one place that says what an edition has, in the shape
// console-where.js already established for the same problem: a module-level
// switch, flipped once by the entry point (`public/local.js` calls
// `onePerson()` at boot), read by the pages as predicates. Everything is
// true until something says otherwise, so the full console is exactly what
// it was and a page that never asks is a page that keeps every word.
//
// A switch and not an argument threaded through six page modules, for the
// reason `oneWhere()` gives: what these answer is a fact about the
// installation, not about a page, and a page that has to be told is a page
// somebody will forget to tell. The predicates are separate rather than one
// `onePerson()` test at every call site, so that a reader of Performance
// sees *why* the Adoption panel is conditional - "this installation has no
// workspaces" - rather than "this installation is the small one".
//
// What each one means, and what turns on it:
//
//   hasTasks          a task is a piece of work with a verdict, handed to an
//                     agent and tracked (server/agent-tasks.js). Nothing
//                     hands one out on a laptop, so "Tasks done", "Rate",
//                     "First time", the median rate and "effective" are
//                     columns and tiles that can only ever read 0 or "—",
//                     and they are the *headline* ones. Performance leads
//                     with sessions, steering and spend instead.
//   hasWorkspaces     a workspace is a group of people (server/workspaces.js).
//                     Without one there is no team to place on the Adoption
//                     ladder - the panel ranked the single account against
//                     itself.
//   hasAgents         agents invited over MCP, with an inviter. Without them
//                     Executors' "Invited by" column is a column of dashes.
//   hasSandboxes      places to run that are not this machine. The local
//                     edition cut sandbox agents (docs/local.md), so a
//                     "Sandbox" dimension on the comparison and the trend
//                     compares one bar with nothing.
//   hasAccessTrail    calls made under a permission, and refusals
//                     (server/access-trail.js). There are no permissions
//                     where there is one person, so the trail is a tab over
//                     an empty list and a subtitle promising to answer a
//                     question nobody here can ask.
//   hasConnectorTools connectors an agent can be lent. This edition's
//                     Connectors page is three git hosts and a token box
//                     (page-git-hosts.js) - useful, and never a tool a
//                     session calls - so the Tools page must not tell a
//                     reader to connect one and wait for it to appear.
//   hasEvaluations    the Evaluations page (console-evaluations.js). The
//                     one predicate that is not "this edition has none of
//                     the thing": the hosted product has the page and the
//                     local one points at it, because it is the answer to
//                     the question the Performance page leaves open.
let tasks = true;
let workspaces = true;
let agents = true;
let sandboxes = true;
let accessTrail = true;
let connectorTools = true;
let evaluations = true;

/**
 * This installation is one person on their own machine.
 *
 * Called by `public/local.js` before anything is drawn, the way
 * `oneWhere()` is. Everything it turns off is a thing that edition has
 * none of; nothing here is a preference or a setting, and there is no way
 * back - an installation does not change edition while the page is open.
 */
export function onePerson() {
  tasks = false;
  workspaces = false;
  agents = false;
  sandboxes = false;
  accessTrail = false;
  connectorTools = false;
  evaluations = false;
}

/** Whether work is handed out as tasks with verdicts, so a row can finish one. */
export const hasTasks = () => tasks;

/** Whether there are groups of people, so a team can be ranked or placed. */
export const hasWorkspaces = () => workspaces;

/** Whether agents are invited by somebody, so a row can say who let it in. */
export const hasAgents = () => agents;

/** Whether work can run anywhere but this machine, so places can be compared. */
export const hasSandboxes = () => sandboxes;

/** Whether calls are made under permissions, so there is a trail of them. */
export const hasAccessTrail = () => accessTrail;

/** Whether connectors are services an agent can call, rather than git hosts. */
export const hasConnectorTools = () => connectorTools;

/**
 * Whether the Evaluations page is here: the worst sessions, what to
 * change, whether it worked. It is the hosted product's - a loop a team
 * runs on its repositories, with a name on each adoption - and the one
 * thing the local edition's Performance page names as being elsewhere
 * (console-performance.js), rather than leaving off in silence.
 */
export const hasEvaluations = () => evaluations;
