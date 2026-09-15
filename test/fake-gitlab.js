// A fake GitLab for the tests that go to GitLab: one project, kept in
// memory, behind a real HTTP server on localhost.
//
// The same shape as fake-github.js and for the same reason: the thing worth
// testing is the translation - GitLab's `iid`, its `opened`, its
// `source_branch`, its URL-encoded project paths - and a stub that answered
// the normalised shape would test nothing at all. So it answers GitLab's own
// JSON, verbatim down to the error bodies, and who is asking is decided by
// the `PRIVATE-TOKEN` header exactly as GitLab decides it.
import http from "node:http";

/** One GitLab's worth of merge requests, kept in memory. */
export function fakeGitLab() {
  const state = {
    token: "glpat-test-token",
    user: { id: 7, username: "ada", name: "Ada Lovelace" },
    /** The project every merge request below is on, path and all - a subgroup, deliberately. */
    project: "ada/platform/engine",
    merges: [],
    /** Every request, as `METHOD /path` - so a test can say what was asked. */
    requests: [],
    /** Which merge requests were read one at a time. */
    pullReads: [],
    /** Every listing, with the query it carried. */
    listings: [],
  };

  /**
   * Add one, in GitLab's own JSON. `state` is GitLab's word for it -
   * "opened", "merged", "closed" - not this app's.
   */
  state.add = ({
    iid,
    title = "A merge request",
    description = null,
    state: said = "opened",
    source_branch = "feature/clock",
    target_branch = "main",
    merged_at = null,
    closed_at = null,
    created_at = "2026-09-01T10:00:00.000Z",
    updated_at = "2026-09-02T10:00:00.000Z",
    merge_commit_sha = null,
    project = state.project,
    author = state.user,
    draft = false,
    changes_count = "3",
  } = {}) => {
    const merge = {
      id: 1000 + iid,
      iid,
      project_id: 42,
      title,
      description,
      state: said,
      source_branch,
      target_branch,
      merged_at,
      closed_at,
      created_at,
      updated_at,
      merge_commit_sha,
      draft,
      work_in_progress: draft,
      changes_count,
      author: { id: author.id, username: author.username, name: author.name },
      references: { full: `${project}!${iid}` },
      web_url: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
    };
    state.merges = state.merges.filter((held) => held.iid !== iid || held.references.full !== merge.references.full).concat(merge);
    return merge;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    state.requests.push(`${req.method} ${url.pathname}`);

    // GitLab's own words for a token it does not know.
    if (req.headers["private-token"] !== state.token) {
      return json(res, 401, { message: "401 Unauthorized" });
    }

    if (url.pathname === "/api/v4/user") return json(res, 200, state.user);

    // One merge request: /projects/<url-encoded path>/merge_requests/<iid>
    const one = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(url.pathname);
    if (one) {
      const project = decodeURIComponent(one[1]);
      const iid = Number(one[2]);
      state.pullReads.push(`${project}!${iid}`);
      const merge = state.merges.find((held) => held.iid === iid && held.references.full.startsWith(`${project}!`));
      return merge ? json(res, 200, merge) : json(res, 404, { message: "404 Not found" });
    }

    // The person's own, across projects.
    if (url.pathname === "/api/v4/merge_requests") {
      state.listings.push(Object.fromEntries(url.searchParams));
      const since = Date.parse(url.searchParams.get("updated_after") ?? "") || 0;
      const mine =
        url.searchParams.get("scope") === "created_by_me"
          ? state.merges.filter((merge) => merge.author.username === state.user.username)
          : state.merges;
      return json(
        res,
        200,
        mine
          .filter((merge) => Date.parse(merge.updated_at) >= since)
          .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)),
      );
    }

    json(res, 404, { message: `no fake for ${req.method} ${url.pathname}` });
  });

  return { state, server };
}

/** Start one, point the git host at it, and hand back the state. */
export async function startFakeGitLab() {
  const gitlab = fakeGitLab();
  await new Promise((resolve) => gitlab.server.listen(0, "127.0.0.1", resolve));
  process.env.CODERVIBES_GITLAB_API = `http://127.0.0.1:${gitlab.server.address().port}/api/v4`;
  return gitlab;
}
