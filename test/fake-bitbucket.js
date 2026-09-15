// A fake Bitbucket for the tests that go to Bitbucket: one workspace's
// pull requests, kept in memory, behind a real HTTP server on localhost.
//
// The same shape as fake-github.js and fake-gitlab.js. What is worth having
// a real server for here is the credential: Bitbucket authenticates with
// HTTP Basic, so the username is half of it, and a fake that took a bearer
// token would let a broken client pass. This one decodes the header exactly
// as Bitbucket does and refuses a wrong username as firmly as a wrong
// password.
import http from "node:http";

/** One Bitbucket workspace's worth of pull requests, kept in memory. */
export function fakeBitbucket() {
  const state = {
    username: "ada",
    token: "app-password-not-a-real-one",
    user: { username: "ada", nickname: "ada", display_name: "Ada Lovelace" },
    repo: "ada/engine",
    pulls: [],
    requests: [],
    pullReads: [],
    listings: [],
    /** A token somebody signed in for: a bearer, with no username half at all. */
    oauthToken: "bb-oauth-token",
    /** Every exchange at the token endpoint, with the form it carried. */
    exchanges: [],
  };

  /** Add one, in Bitbucket's own JSON. `state` is its own word: OPEN, MERGED, DECLINED, SUPERSEDED. */
  state.add = ({
    id,
    title = "A pull request",
    description = null,
    state: said = "OPEN",
    source = "feature/clock",
    destination = "main",
    created_on = "2026-09-01T10:00:00.000000+00:00",
    updated_on = "2026-09-02T10:00:00.000000+00:00",
    merge_commit = null,
    repo = state.repo,
    draft = false,
  } = {}) => {
    const pull = {
      id,
      title,
      description,
      state: said,
      draft,
      created_on,
      updated_on,
      merge_commit: merge_commit ? { hash: merge_commit } : null,
      author: { nickname: state.user.nickname, display_name: state.user.display_name },
      source: { branch: { name: source }, repository: { full_name: repo } },
      destination: { branch: { name: destination }, repository: { full_name: repo } },
      links: { html: { href: `https://bitbucket.org/${repo}/pull-requests/${id}` } },
    };
    state.pulls = state.pulls.filter((held) => !(held.id === id && held.destination.repository.full_name === repo)).concat(pull);
    return pull;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    state.requests.push(`${req.method} ${url.pathname}`);

    // The sign-in's token endpoint, which is on bitbucket.org rather than
    // on the API and carries the client's id and secret in the form.
    // Before the gate below, for that reason.
    if (req.method === "POST" && url.pathname === "/site/oauth2/access_token") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
        state.exchanges.push(form);
        if (form.client_secret !== "bb-client-secret") {
          return json(res, 400, { error: "unauthorized_client", error_description: "Client credentials are invalid." });
        }
        if (form.grant_type === "authorization_code" && form.code !== "bb-good-code") {
          return json(res, 400, { error: "invalid_grant", error_description: "The authorization code is invalid." });
        }
        // Two hours, with a refresh token: Bitbucket's own lifetimes.
        return json(res, 200, {
          access_token: state.oauthToken,
          token_type: "bearer",
          refresh_token: "bb-refresh",
          expires_in: 7200,
          scopes: "pullrequest account",
        });
      });
      return undefined;
    }

    // Basic, as Bitbucket takes it: both halves, or its own words back. A
    // token from a sign-in is a bearer instead, and carries no username -
    // which is the half of this the cloud has to get right.
    const header = String(req.headers.authorization ?? "");
    const pair = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
    const [username, token] = pair.split(":");
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!(bearer && bearer === state.oauthToken) && (username !== state.username || token !== state.token)) {
      return json(res, 401, { type: "error", error: { message: "Invalid credentials" } });
    }

    if (url.pathname === "/2.0/user") return json(res, 200, state.user);

    const one = /^\/2\.0\/repositories\/([^/]+)\/([^/]+)\/pullrequests\/(\d+)$/.exec(url.pathname);
    if (one) {
      const repo = `${decodeURIComponent(one[1])}/${decodeURIComponent(one[2])}`;
      const id = Number(one[3]);
      state.pullReads.push(`${repo}#${id}`);
      const pull = state.pulls.find((held) => held.id === id && held.destination.repository.full_name === repo);
      return pull ? json(res, 200, pull) : json(res, 404, { type: "error", error: { message: "Resource not found" } });
    }

    // The person's own, across repositories.
    const mine = /^\/2\.0\/pullrequests\/([^/]+)$/.exec(url.pathname);
    if (mine) {
      state.listings.push({ who: decodeURIComponent(mine[1]), query: url.searchParams.getAll("q"), state: url.searchParams.getAll("state") });
      const wanted = new Set(url.searchParams.getAll("state").map((word) => word.toUpperCase()));
      const values = state.pulls
        .filter((pull) => !wanted.size || wanted.has(pull.state))
        .sort((a, b) => Date.parse(b.updated_on) - Date.parse(a.updated_on));
      return json(res, 200, { values, pagelen: values.length, size: values.length, page: 1 });
    }

    json(res, 404, { type: "error", error: { message: `no fake for ${req.method} ${url.pathname}` } });
  });

  return { state, server };
}

/**
 * Start one, point the git host at it, and hand back the state.
 *
 * `web` is where the sign-in's two endpoints are - the connector reads it
 * at import, so a test that wants them sets CODERVIBES_BITBUCKET_WEB from
 * this before importing the connector.
 */
export async function startFakeBitbucket() {
  const bitbucket = fakeBitbucket();
  await new Promise((resolve) => bitbucket.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${bitbucket.server.address().port}`;
  process.env.CODERVIBES_BITBUCKET_API = origin;
  bitbucket.origin = origin;
  bitbucket.web = origin;
  return bitbucket;
}
