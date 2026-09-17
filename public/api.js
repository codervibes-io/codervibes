import { isFirebase } from "./auth-mode.js";
import { param as whereParam } from "./console-where.js";

/**
 * Every call carries the ID token when Firebase auth is on.
 *
 * auth.js is imported here rather than at the top because it carries the
 * Firebase SDK's boot and the hosted project's configuration, and an
 * installation with no sign-in - the local edition - would otherwise load
 * both to be told, on every call, that there is no token. The import is taken
 * once, on the first call of an installation that has sign-in.
 */
let firebase = null;
async function authorized(options = {}) {
  if (!isFirebase()) return options;
  firebase ??= await import("./auth.js");
  const token = await firebase.idToken();
  if (!token) return options;
  return { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } };
}

async function request(url, options = {}) {
  const res = await fetch(url, await authorized(options));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(res, data);
  return data;
}

/**
 * Turn an error response into an Error that still says what kind it was.
 *
 * `signInRequired` is the one that matters: the server sets it when the answer
 * is "you need an account", and gate.js turns that into the sign-in dialog
 * rather than a red toast. A bare message loses that.
 */
function failure(res, data) {
  const error = new Error(data.error || `${res.status} ${res.statusText}`);
  error.status = res.status;
  error.signInRequired = Boolean(data.signInRequired);
  return error;
}

/**
 * A listing read, which every page scopes the same way: to the open
 * workspace's own repos, plus whatever the reader has pressed for on the
 * Include filter (console-where.js). It is appended here rather than at
 * each call site so that the four pages that share the filter cannot
 * drift - a page that forgot to pass it would quietly show a different
 * set of work from the one whose chips are pressed.
 */
const listing = (url) => request(`${url}${url.includes("?") ? "&" : "?"}where=${encodeURIComponent(whereParam())}`);

const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  config: () => request("/api/config"),
  session: () => request("/api/session"),
  /**
   * Throw this account away - repos, sandboxes, answers and all - so the
   * next sign-in is a signup again. Offered only when the session says
   * `canReset`; see server/account-reset.js.
   */
  resetAccount: () => request("/api/account/reset", { method: "POST" }),
  /** The Account page, in one read - see server/account.js. */
  account: () => request("/api/account"),
  renameAccount: (name) => request("/api/account", { ...json({ name }), method: "PUT" }),
  /** Change how the console behaves for this person - see server/account.js SETTINGS. */
  saveSettings: (settings) => request("/api/account", { ...json({ settings }), method: "PUT" }),
  /**
   * Everything, gone: the server wants the address typed back and checks it
   * itself. Not gated like the reset - this is for anybody who wants out.
   */
  deleteAccount: (confirm) => request("/api/account", { ...json({ confirm }), method: "DELETE" }),
  signIn: (email) => request("/api/session", json({ email })),
  claimSession: () => request("/api/session", { method: "POST" }),
  signOut: () => request("/api/session", { method: "DELETE" }),

  // Workspaces: who works with whom, and so who sees what. The session
  // carries the open one and the list; these change them. A switch sets a
  // cookie, so what every route after it lists is the other workspace's -
  // which is why the console re-reads everything after one.
  workspaces: () => request("/api/workspaces"),
  createWorkspace: (name) => request("/api/workspaces", json({ name })),
  switchWorkspace: (id) => request(`/api/workspaces/${encodeURIComponent(id)}/switch`, { method: "POST" }),
  renameWorkspace: (id, name) =>
    request(`/api/workspaces/${encodeURIComponent(id)}`, { ...json({ name }), method: "PATCH" }),
  inviteToWorkspace: (id, email) =>
    request(`/api/workspaces/${encodeURIComponent(id)}/members`, json({ email })),
  /** Somebody out - or yourself, which is leaving. Their repos in it go home with them. */
  removeFromWorkspace: (id, email) =>
    request(`/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(email)}`, { method: "DELETE" }),
  deleteWorkspace: (id) => request(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** `extra` carries where it comes from: `{ repo, branch }` on GitHub. */
  createRepo: (name, extra = {}) => request("/api/repos", json({ name, ...extra })),
  /** Repositories a repo can be made from, and how to get more (the App's install link). */
  githubRepos: () => request("/api/github/repos"),
  /**
   * What to POST to GitHub to have it make this installation's App. Not
   * posted from here - creating an App from a manifest is a form that
   * navigates - so this only fetches what the form needs.
   */
  githubAppManifest: (name = "") =>
    request(`/api/github/app/manifest${name ? `?name=${encodeURIComponent(name)}` : ""}`),
  /**
   * A merged pull request line by line: which session wrote each added
   * line (server/pull-lines.js). Read on demand - it costs GitHub a read
   * of the diff - and never with the page.
   */
  pullLines: (repository, number) =>
    request(`/api/pulls/${String(repository).split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(number)}/lines`),
  mergePull: (id, number, method = "squash") =>
    request(`/api/repos/${encodeURIComponent(id)}/pulls/${encodeURIComponent(number)}/merge`, json({ method })),
  /** Bring a task waiting on a person back to its agent, with what the person says. */
  resumeTask: (id, taskId, note = "") =>
    request(`/api/repos/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/resume`, json({ note })),
  // The owner decides an agent's access request: {decision: "approve"|"deny", duration: "30m"|"2h"|"1d", note}.
  decideAccess: (id, requestId, body) =>
    request(`/api/repos/${encodeURIComponent(id)}/access-requests/${encodeURIComponent(requestId)}`, json(body)),
  // The owner decides one gated call (action-approvals.js): {decision: "approve"|"deny", note}.
  decideAction: (id, approvalId, body) =>
    request(`/api/repos/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, json(body)),
  // Inviting an agent returns its token, once. There is no route that reads it
  // back - the server keeps only a hash.
  inviteAgent: (id, name, permissions) =>
    request(
      `/api/repos/${encodeURIComponent(id)}/agents`,
      json({ name, permissions }),
    ),
  // Every agent this account has, wherever it lives. Feeds the picker that
  // adds an existing one to a second repo rather than minting a token
  // per repo. The same body as `executors`, under the old name.
  myAgents: () => request("/api/agents"),
  /**
   * Everything that does work for this account, on one list: the agents,
   * the harnesses on their own machines reporting here, and the vendors'
   * agents - each with where it runs and who invited it. The Executors page.
   */
  executors: () => request("/api/executors"),
  /**
   * Forget a machine that reported here: its row goes and its place under
   * the cap comes free (server/local.js). The sessions that ran on it are
   * what happened and stay, and it comes back if it reports again - it is
   * not a block list. Served by the installations that have a cap; the
   * hosted product has none, and its console never presses this.
   */
  forgetExecutor: (id) => request(`/api/executors/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** One executor's standing over a range, its days one by one, and what it reached for. */
  executorStats: (id, range = "7d") =>
    request(`/api/executors/${encodeURIComponent(id)}/stats?range=${encodeURIComponent(range)}`),
  /** The one grant, and the repos it is a member of. Either may be omitted to leave it as it is. */
  setExecutorAccess: (id, { permissions, repos, askFirst } = {}) =>
    request(`/api/executors/${encodeURIComponent(id)}/access`, { ...json({ permissions, repos, askFirst }), method: "PUT" }),
  // The same agent, same token, in another repo - with that repo's
  // own permissions. This is what makes switch_repo have anywhere to go.
  grantAgent: (id, agentId, permissions) =>
    request(`/api/repos/${encodeURIComponent(id)}/agents`, json({ agentId, permissions })),
  /**
   * The models an agent may think with, and which providers this account
   * has a key for. Feeds the picker on the new-agent dialog and an agent's
   * Settings tab.
   */
  models: () => request("/api/models"),
  /** Change what an agent may do in one repo, what it is for, or what it thinks with. */
  updateAgent: (id, agentId, patch) =>
    request(
      `/api/repos/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`,
      { ...json(patch), method: "PATCH" },
    ),
  revokeAgent: (id, agentId) =>
    request(
      `/api/repos/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
    ),
  /**
   * The agent, gone: out of every repo at once, its token dead
   * everywhere, its process stopped if it lives in a sandbox. `revokeAgent`
   * is one repo's permission; this is the thing itself.
   */
  deleteAgent: (agentId) =>
    request(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }),

  // ------------------------------------------------------------- console
  //
  // The agent console at `/`. These are its four questions: what have my
  // agents been doing, what machines are there, what can I open, and how do I
  // tell one of them it is wrong.



  /**
   * What is being worked on right now and what was finished lately -
   * everyone's, one entry per session. The Home page.
   */
  home: () => listing("/api/home"),
  // The same page with every kind of work in it, asked for on purpose by
  // an empty Activity page to say how much "Workspace only" is leaving out
  // (console-home.js `hiddenWork`). Not `listing`: this read wants every
  // kind whatever the chips say, and is the only one that does.
  homeEverywhere: () => request("/api/home?where=workspace,external,none"),
  /** Everyone's sessions over "24h", "7d" or "30d" - what Home is cut from. */
  activity: (range = "24h") => listing(`/api/activity?range=${encodeURIComponent(range)}`),
  /** The ranking, grouped by "sessions" (the Performance page), "agents", "harnesses" or "users". */
  performance: (range = "7d", by = "sessions") =>
    listing(`/api/performance?range=${encodeURIComponent(range)}&by=${encodeURIComponent(by)}`),
  performanceCompare: (range = "7d") => listing(`/api/performance/compare?range=${encodeURIComponent(range)}`),
  /**
   * What got in the agents' way over the range, folded three ways at once
   * (server/friction.js). `by` says which fold the panel opens on; all
   * three come back either way, so switching is not another request.
   */
  performanceFriction: (range = "7d", by = "repo") =>
    listing(`/api/performance/friction?range=${encodeURIComponent(range)}&by=${encodeURIComponent(by)}`),
  /** What was changed about how the agents work here, and what happened either side of each change. */
  performanceHarness: (range = "7d") => listing(`/api/performance/harness?range=${encodeURIComponent(range)}`),
  /**
   * The Evaluations page: the worst sessions of the range with what was
   * found on each, and the recommendations with what became of them
   * (server/pages/evaluations.js). One read; the write is what somebody
   * did about one recommendation - adopt (with a mechanism, or the sha of
   * a harness change), dismiss, reopen.
   */
  evaluations: (range = "7d") => listing(`/api/evaluations?range=${encodeURIComponent(range)}`),
  evaluationAct: (id, body) => request(`/api/evaluations/${encodeURIComponent(id)}`, json(body)),
  /** How far each person has taken this: the share, the ladder, and where the team is. */
  performanceAdoption: (range = "7d") => listing(`/api/performance/adoption?range=${encodeURIComponent(range)}`),
  tools: (range = "7d") => listing(`/api/tools?range=${encodeURIComponent(range)}`),
  // The Workflows page - see server/workflows.js: every pipeline with its
  // stats, one pipeline with its runs, one run with its steps and logs,
  // and a read of the caller's own engines now rather than at the next tick.
  workflows: (range = "7d") => request(`/api/workflows?range=${encodeURIComponent(range)}`),
  workflowPipeline: (id, range = "7d") => request(`/api/workflows/${encodeURIComponent(id)}?range=${encodeURIComponent(range)}`),
  workflowRun: (pipeline, run) => request(`/api/workflows/${encodeURIComponent(pipeline)}/runs/${encodeURIComponent(run)}`),
  syncWorkflows: () => request("/api/workflows/sync", { method: "POST" }),
  runWorkflowAgain: (id) => request(`/api/workflows/${encodeURIComponent(id)}/run`, { method: "POST" }),
  /**
   * Search: the best sessions, connectors, tools and skills for a question
   * over the sessions' `range`, with the histogram of when the matching
   * sessions were; `from`/`to` (ms) narrow the list to one of its bars, and
   * `provider` to the sessions done on one vendor's models and `machine` to
   * the sessions one machine ran - which is how a machine's page links to
   * its work.
   */
  search: (q, { kind = "", provider = null, machine = null, range = "all", from = null, to = null } = {}) =>
    listing(`/api/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}&range=${encodeURIComponent(range)}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}${machine ? `&machine=${encodeURIComponent(machine)}` : ""}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
  /**
   * Search's answer to the question, worked out by the installation's model
   * from the hits; takes a few seconds. Asked for - the AI assist button, or
   * the account that always wants one. `history` is the chat so far, as
   * `{ question, answer }` turns, which makes a follow-up a follow-up.
   */
  searchAnswer: (q, history = []) => request("/api/search/answer", { ...json({ q, history }), method: "POST" }),
  /** The access trail, fuzzily, for `q` (or all of it, newest first), with its histogram and sums; `from`/`to` as above. */
  searchTrail: (q, { range = "all", from = null, to = null } = {}) =>
    listing(`/api/search/trail?q=${encodeURIComponent(q)}&range=${encodeURIComponent(range)}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
  /** What the range was used for: sessions, calls, cost, the tools and permissions reached for most, the calls over time. */
  searchStats: (range = "all") => listing(`/api/search/stats?range=${encodeURIComponent(range)}`),
  tool: (name, range = "7d") => listing(`/api/tools/${encodeURIComponent(name)}?range=${encodeURIComponent(range)}`),
  /** One session, with its timeline, tasks and pull requests. */
  sessionDetail: (id) => request(`/api/sessions/${encodeURIComponent(id)}`),
  /**
   * A session's log from `since` (a seq; 0 for the start) - what it said and
   * did, in ACP's shape. `next` in the answer is where to ask from next time.
   */
  sessionEvents: (id, since = 0) =>
    request(`/api/sessions/${encodeURIComponent(id)}/events?since=${encodeURIComponent(since)}`),
  /** ACP's session/cancel: stop the session's current turn. The session goes on. */
  cancelSession: (id) => request(`/api/sessions/${encodeURIComponent(id)}/cancel`, json({})),
  /** One agent's sessions in the month - the same rows Home lists, for its Activity tab. */
  agentSessions: (id, range = "30d") =>
    request(`/api/agents/${encodeURIComponent(id)}/sessions?range=${encodeURIComponent(range)}`),



  /**
   * What is happening, as it happens - the Response, read by the caller.
   *
   * Not an EventSource for the same reason `assistantStream` is not: it
   * cannot carry the Authorization header, and with Firebase auth the server
   * knows a person by nothing else. `lastId` goes as the header an
   * EventSource would have sent, so the server can replay what was missed.
   */
  stream: async (lastId) =>
    fetch(
      "/api/agents/stream",
      await authorized({ headers: lastId ? { "Last-Event-ID": lastId } : {} }),
    ),


  /**
   * The account's ingest token and what to do with it: the settings file
   * that makes your own Claude Code report here. See server/ingest-token.js.
   *
   * The GET mints one the first time it is asked, because that is the whole
   * point of the panel it draws. A token minted earlier cannot be shown
   * again - only its hash is kept - so `token` is null and the steps carry a
   * placeholder until `rotateIngest`.
   */
  ingest: () => request("/api/ingest"),

  // The git hosts a person connects with their own token, so the pull
  // requests they open are followed to a merge and Performance counts them
  // (server/git-hosts/). Never carries a token back: `gitHosts` answers the
  // account each is connected as, and nothing else.
  gitHosts: () => request("/api/git-hosts"),
  /** `{ token }`, and `{ username, token }` for Bitbucket, which signs in with both halves. */
  connectGitHost: (host, body) => request(`/api/git-hosts/${encodeURIComponent(host)}`, json(body)),
  disconnectGitHost: (host) => request(`/api/git-hosts/${encodeURIComponent(host)}`, { method: "DELETE" }),
  /** Ask the host now rather than at the next tick - the Check now button. */
  syncGitHost: (host) => request(`/api/git-hosts/${encodeURIComponent(host)}/sync`, { method: "POST" }),
  rotateIngest: () => request("/api/ingest/rotate", { method: "POST" }),
  /**
   * The LiteLLM connector: whether this installation has a proxy, and how
   * the proxy is told to send its traces here. Mints the ingest token the
   * same way `ingest` does, and shows it under the same rule.
   */
  litellm: () => request("/api/connectors/litellm"),
  /**
   * Turn the proxy this installation runs on or off. On starts its
   * machines and points every agent's calls at it; off stops them and
   * gives back whichever proxy was connected before. Answers with the whole
   * page's state, so the caller redraws from it rather than re-reading.
   */
  litellmManaged: (use) => request("/api/connectors/litellm/managed", json({ use })),
  /** Connect a proxy of your own. Checked against the proxy before it is kept. */
  litellmOwn: ({ upstream, key, master }) => request("/api/connectors/litellm/own", json({ upstream, key, master })),

  /**
   * The provider keys the installation's proxy calls with. The value goes
   * up and never comes back: the answer says which providers are held and
   * which the proxy has, and no key is ever in a response.
   */
  setGatewayKey: (provider, value) =>
    request(`/api/connectors/litellm/providers/${encodeURIComponent(provider)}`, { ...json({ value }), method: "PUT" }),
  forgetGatewayKey: (provider) =>
    request(`/api/connectors/litellm/providers/${encodeURIComponent(provider)}`, { method: "DELETE" }),
  /** The e2b connector's page: the sandboxes its key can see right now. */
  e2bSandboxes: () => request("/api/connectors/e2b/sandboxes"),
  // Slack workspaces that can reach here - the inbound half, separate from
  // the Slack connector's own bot token. See server/slack-grant.js.
  slackWorkspaces: () => request("/api/slack/workspaces"),
  slackLink: () => request("/api/slack/link", { method: "POST" }),
  disconnectSlackWorkspace: (id) =>
    request(`/api/slack/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * Harnesses: what an agent's work runs in - this app's loop, Claude Code,
   * or something on your own machine reporting here. See server/harnesses.js.
   * Making one answers with its token once; afterwards `harnessConnect` shows
   * the same steps with a placeholder where the token was.
   */
  harnesses: () => request("/api/harnesses"),
  /**
   * `agent` is the invited agent this harness reports for - `{id, name}`,
   * and `{url, token}` too when the credential was just minted, so the
   * answer's connect steps carry the MCP line in the harness's own format.
   * The credential is not stored; it is in the answer and then gone.
   */
  createHarness: ({ name, kind, where, sandboxTemplate, isDefault, agent = null }) =>
    request("/api/harnesses", json({ name, kind, where, sandboxTemplate, default: isDefault, agent })),
  harnessConnect: (id) => request(`/api/harnesses/${encodeURIComponent(id)}/connect`),
  /** The harness reporting for one of your agents, with its connect steps - or none. */
  agentHarness: (agentId) => request(`/api/agents/${encodeURIComponent(agentId)}/harness`),
  defaultHarness: (id) => request(`/api/harnesses/${encodeURIComponent(id)}/default`, { method: "PUT" }),
  removeHarness: (id) => request(`/api/harnesses/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * External agents: somebody else's agent - Greptile, Niteshift, a vendor's
   * own - reached over MCP and acting on GitHub as a bot. See
   * server/external-agents/. Making one verifies the endpoint before the
   * record is kept; the secret is named, never carried, like a connector's.
   */
  externalPresets: () => request("/api/external-agents/presets"),
  externalAgents: () => request("/api/external-agents"),
  externalAgent: (id) => request(`/api/external-agents/${encodeURIComponent(id)}`),
  createExternalAgent: ({ vendor, name, url, secret, login, expose, repos }) =>
    request("/api/external-agents", json({ vendor, name, url, secret, login, expose, repos })),
  updateExternalAgent: (id, patch) =>
    request(`/api/external-agents/${encodeURIComponent(id)}`, { ...json(patch), method: "PUT" }),
  deleteExternalAgent: (id) =>
    request(`/api/external-agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Ask the endpoint again - after a rotated secret, or for tools the vendor added. */
  verifyExternalAgent: (id) =>
    request(`/api/external-agents/${encodeURIComponent(id)}/verify`, { method: "POST" }),
  /** Read its runs from the vendor now rather than at the next poll. */
  syncExternalAgent: (id) =>
    request(`/api/external-agents/${encodeURIComponent(id)}/sync`, { method: "POST" }),
  /** One of its tools, called as its owner from its page. Answers `{text}`. */
  callExternal: (id, tool, args) =>
    request(`/api/external-agents/${encodeURIComponent(id)}/call`, json({ tool, args })),
  /** Its sessions over the last month: what the vendor reported, what GitHub heard. */
  externalSessions: (id) => request(`/api/external-agents/${encodeURIComponent(id)}/sessions`),
  /** A file that configures it in a repository, from the default branch. Null content when not there. */
  externalConfig: (id, repo, path) =>
    request(
      `/api/external-agents/${encodeURIComponent(id)}/config?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
    ),
  /** Write it back - as a branch and a pull request, never to the default branch. */
  saveExternalConfig: (id, repo, path, content) =>
    request(`/api/external-agents/${encodeURIComponent(id)}/config`, {
      ...json({ repo, path, content }),
      method: "PUT",
    }),
  /** Give it a task on a pull request, for a vendor that takes one that way. */
  dispatchExternal: (id, repo, number, prompt) =>
    request(`/api/external-agents/${encodeURIComponent(id)}/dispatch`, json({ repo, number, prompt })),

  // --------------------------------------------------------- connectors
  //
  // What your agents can reach, and what they reach it with. Connecting names
  // a *secret* rather than carrying a token: the value was stored under
  // /api/secrets and nothing here has ever seen it.

  connectors: () => request("/api/connectors"),
  connect: (id, secret) =>
    request(`/api/connectors/${encodeURIComponent(id)}`, json({ secret })),
  /**
   * Or by signing in: the answer is the service's own page to open in a
   * window, which comes back to the server with the token. Nothing here
   * ever sees it - see console-connectors.js signInWith.
   */
  connectBySignIn: (id) =>
    request(`/api/connectors/${encodeURIComponent(id)}/oauth`, json({})),
  setConnectionWrites: (id, writes) =>
    request(`/api/connectors/${encodeURIComponent(id)}/writes`, {
      ...json({ writes }),
      method: "PUT",
    }),
  disconnect: (id) =>
    request(`/api/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Ask the assistant to turn a description of an API into a spec. */
  draftConnector: (description, notes) =>
    request("/api/connectors/draft", json({ description, notes })),
  saveConnector: (spec) =>
    request("/api/connectors/custom", { ...json({ spec }), method: "PUT" }),
  deleteConnector: (id) =>
    request(`/api/connectors/custom/${encodeURIComponent(id)}`, { method: "DELETE" }),


  // ------------------------------------------------------------ secrets
  //
  // Write-only, by design: there is no route that reads a value back, so
  // there is no method here that could.

  secrets: () => request("/api/secrets"),
  putSecret: (name, value, host) =>
    request(`/api/secrets/${encodeURIComponent(name)}`, {
      ...json({ value, host }),
      method: "PUT",
    }),
  deleteSecret: (name) =>
    request(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // Open to people who are not signed in: the About page is the one page a
  // stranger reads, and making them make an account before they can say what
  // is wrong with the product defeats the point of asking.
  /**
   * Say something about the product, with an address to answer at. `replyTo`
   * is optional and may be empty: signed in it arrives as the account's own
   * address, signed out it is whatever was typed, and neither is required.
   */
  sendFeedback: (message, replyTo = "") => request("/api/feedback", json({ message, replyTo })),
};

/**
 * A file the server means the browser to save.
 *
 * Not a plain <a href>: with Firebase auth every request carries a bearer
 * token, and a link carries nothing - so on prod a bare link is a 401 saved
 * to the Downloads folder. It is fetched like everything else and handed
 * back as a blob, which also means a refusal arrives as a message rather
 * than as a downloaded file containing an error. The name is the server's,
 * off the Content-Disposition it set.
 */
export async function fetchFile(url, fallbackName = "download") {
  const res = await fetch(url, await authorized({}));
  if (!res.ok) throw failure(res, await res.json().catch(() => ({})));
  const disposition = res.headers.get("content-disposition") ?? "";
  const name = disposition.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  return { blob: await res.blob(), name };
}

/** The repo as a zip. */
export const exportRepo = () => fetchFile("/api/export", "repo.zip");

/**
 * The Performance page's rows as a file - `what` is "sessions" or "pulls",
 * `format` is "csv" or "json". Scoped like every listing: the same range the
 * page is showing and the same Include filter, so the file holds what the
 * reader was looking at rather than something the server chose.
 */
export const exportRows = (what, format, range = "7d") =>
  fetchFile(
    `/api/export/${what}.${format}?range=${encodeURIComponent(range)}&where=${encodeURIComponent(whereParam())}`,
    `codervibes-${what}-${range}.${format}`,
  );

/** POST JSON, then yield each newline-delimited JSON event from the response. */
export async function* streamNdjson(url, body, signal) {
  const res = await fetch(url, { ...(await authorized(json(body))), signal });
  if (!res.ok) {
    throw failure(res, await res.json().catch(() => ({})));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // A partial line can't happen here (we split on newline), so a parse
        // failure means a malformed event - skip it rather than kill the stream.
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {
      /* ignore trailing garbage */
    }
  }
}
