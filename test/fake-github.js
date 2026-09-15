// A fake GitHub for the tests that go to GitHub: one repository, ada/engine,
// kept in memory, behind a real HTTP server on localhost.
//
// A fake that behaves like the real one where it matters: the archive is a
// real gzipped tarball with GitHub's one-directory wrapper, the git-data
// endpoints hand out and take real-looking objects, blobs get the sha git
// would give them. And the App's side of GitHub: installations, the tokens
// minted for them, and who may push - so the seam in server/repo-sources can
// be tested choosing between an installation token and a person's own.
//
// Who is asking is decided by the Authorization header. A JWT (three
// dot-separated parts) is the App itself and may only reach the App
// endpoints; `state.token` is the person's own token; a token this fake
// minted for an installation is that installation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/** One repository's worth of GitHub, kept in memory. */
export function fakeGitHub() {
  const state = {
    token: "ghp_test_token",
    repo: {
      full_name: "ada/engine", name: "engine", html_url: "https://github.com/ada/engine",
      description: "The difference engine", default_branch: "main", private: true,
      permissions: { push: true },
    },
    blobs: new Map(),        // sha -> { content(utf8) }
    trees: new Map(),        // sha -> [{path, sha, type, size}]
    commits: new Map(),      // sha -> { tree, parents, message }
    branches: new Map(),     // name -> commit sha
    pulls: [],
    requests: [],
    /** The tree the tarball is built from: path -> text. */
    files: {},
    // The App's side.
    installations: [],       // [{ id, account: {login, type}, repository_selection, repos: [full_name] }]
    installTokens: new Map(),// token -> installation id
    collaborators: new Map(),// login -> permission (role_name)
    mergeRefused: null,      // a message, to have the merge endpoint answer 405
    mergeableState: "clean", // what GET /pulls/:n says of mergeable_state
    pullReads: [],           // who read a pull request, in order: "owner" | "installation" | "jwt"
    pullListings: [],        // every GET /pulls that listed the repository, with what it asked for
    searches: [],            // every GET /search/issues, with the query it carried
    // What the App is registered with - the manifest's, unless a test
    // registers less by hand. A token minted for the App is limited by it,
    // and so is a person's sign-in through it (a `ghu_` token).
    appPermissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    appOwner: { login: "ada", type: "User" },
    // What the person's own token may do - a fine-grained personal token
    // is granted per permission, and a merge is contents and pull
    // requests write. Both, unless a test narrows it.
    tokenPermissions: { contents: "write", pull_requests: "write" },
    minted: 0,
    created: [],             // repositories made with POST /user/repos, in order
    // Making an App from a manifest. The code is the whole credential and is
    // good for one exchange; `pem` is what GitHub would generate and show once.
    manifestCode: "manifest-code",
    manifestPem: "-----BEGIN RSA PRIVATE KEY-----\nmade-by-github\n-----END RSA PRIVATE KEY-----\n",
    conversions: 0,
  };
  let counter = 0;
  const sha = (prefix) => prefix + String(++counter).padStart(39, "0");
  // Blobs get the sha git would give them, because that is what the module
  // compares against: a fake that numbered them would call every file changed.
  const blobSha = (content) =>
    createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

  /** One held pull request in GitHub's own JSON, for the listing and the single read. */
  const listed = (pull) => ({
    number: pull.number,
    html_url: pull.html_url,
    title: pull.title ?? null,
    body: pull.body ?? null,
    state: pull.state,
    merged: Boolean(pull.merged),
    merge_commit_sha: pull.merge_commit_sha ?? null,
    head: { ref: pull.head },
    base: { ref: pull.base },
    user: pull.user ?? { login: "ada" },
    draft: Boolean(pull.draft),
    created_at: pull.created_at ?? new Date().toISOString(),
    merged_at: pull.merged_at ?? null,
    closed_at: pull.closed_at ?? null,
  });

  /** Lay `files` down as blobs, a tree and a commit on `branch`. */
  state.seed = (branch, files, { parent = null } = {}) => {
    const entries = [];
    for (const [file, content] of Object.entries(files)) {
      const id = blobSha(content);
      state.blobs.set(id, { content });
      entries.push({ path: file, sha: id, type: "blob", size: Buffer.byteLength(content) });
    }
    const treeSha = sha("7");
    state.trees.set(treeSha, entries);
    const commitSha = sha("c");
    state.commits.set(commitSha, { tree: treeSha, parents: parent ? [parent] : [], message: "seed" });
    state.branches.set(branch, commitSha);
    state.files = { ...files };
    return commitSha;
  };

  /** Install the App on ada/engine (and whatever else) as `login`. */
  state.install = ({ id = 4242, login = "ada", type = "User", repos = ["ada/engine"], selection = "selected", permissions = null } = {}) => {
    // What the installation accepted: the App's own, unless a test says it
    // is behind on a widening.
    const installation = { id, account: { login, type }, repository_selection: selection, repos, permissions };
    state.installations = state.installations.filter((entry) => entry.id !== id).concat(installation);
    return installation;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const read = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
  const installationJson = (installation) => ({
    id: installation.id,
    account: installation.account,
    repository_selection: installation.repository_selection,
    permissions: installation.permissions ?? state.appPermissions,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    state.requests.push(`${req.method} ${url.pathname}`);
    // Signing in through the App: GitHub's OAuth exchange, which takes no
    // credential but the code (and the App's client id and secret, which
    // this fake does not check). The token it hands out is the owner's own,
    // so a signed-in person is the same `isOwner` a pasted token was - the
    // tests below connect GitHub this way, as the console does.
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const raw = await new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => resolve(body));
      });
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (form.code && form.code !== "good-code") return json(res, 200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      state.signIns = (state.signIns ?? 0) + 1;
      return json(res, 200, { access_token: state.token, refresh_token: "ghr_fake_refresh", expires_in: 28800, refresh_token_expires_in: 15811200, token_type: "bearer" });
    }
    // Turning a manifest code into an App takes no credential at all - the
    // code is the credential - so it is answered before the check below.
    const conversion = url.pathname.match(/^\/app-manifests\/([^/]+)\/conversions$/);
    if (conversion && req.method === "POST") {
      if (conversion[1] !== state.manifestCode) return json(res, 404, { message: "Not Found" });
      // One exchange, as GitHub does it: a retry with the same code gets nothing.
      state.manifestCode = null;
      state.conversions += 1;
      return json(res, 201, {
        id: 4242,
        slug: "codervibes-made",
        name: "CoderVibes",
        html_url: "https://github.com/apps/codervibes-made",
        pem: state.manifestPem,
        webhook_secret: "made-up-hook-secret",
        client_id: "Iv23made-up-client",
        client_secret: "made-up-client-secret",
      });
    }

    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const isJwt = bearer.split(".").length === 3;
    const installationId = state.installTokens.get(bearer) ?? null;
    const isOwner = bearer === state.token;
    if (!isJwt && !isOwner && installationId === null) return json(res, 401, { message: "Bad credentials" });
    // GitHub does not care about the case of an owner or a repository name,
    // so neither does this. A repository made through POST /user/repos is
    // the same one repository under another name: the git data behind it is
    // ada/engine's, which is all a test of "the files got there" needs.
    const created = state.created.find((entry) => {
      const own = `/repos/ada/${entry.name.toLowerCase()}`;
      return url.pathname.toLowerCase() === own || url.pathname.toLowerCase().startsWith(`${own}/`);
    });
    const p = (created ? url.pathname.replace(/^\/repos\/ada\/[^/]+/, "/repos/ada/engine") : url.pathname)
      .replace(/^\/repos\/ada\/engine/i, "/repos/ada/engine");
    const body = req.method === "POST" || req.method === "PATCH" || req.method === "PUT" ? await read(req) : null;
    // The repository itself answers under its own name, though: a test that
    // connects two repositories needs them to stay two, and what the app
    // records is the full_name GitHub answers with.
    if (created && p === "/repos/ada/engine" && req.method === "GET" && !isJwt) {
      return json(res, 200, {
        ...state.repo, full_name: `ada/${created.name}`, name: created.name,
        html_url: `https://github.com/ada/${created.name}`, private: created.private, description: created.description,
      });
    }

    // ---- the App itself (JWT only)
    if (p === "/app" || p.startsWith("/app/") || /^\/repos\/[^/]+\/[^/]+\/installation$/.test(p)) {
      if (!isJwt) return json(res, 401, { message: "A JWT is required" });
      if (p === "/app") return json(res, 200, { id: 777, slug: "codervibes-test", owner: state.appOwner, permissions: state.appPermissions });
      if (p === "/app/installations") return json(res, 200, state.installations.map(installationJson));
      const one = p.match(/^\/app\/installations\/(\d+)$/);
      if (one) {
        const installation = state.installations.find((entry) => String(entry.id) === one[1]);
        return installation ? json(res, 200, installationJson(installation)) : json(res, 404, { message: "Not Found" });
      }
      const mint = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (mint && req.method === "POST") {
        const installation = state.installations.find((entry) => String(entry.id) === mint[1]);
        if (!installation) return json(res, 404, { message: "Not Found" });
        state.minted += 1;
        const token = `ghs_${mint[1]}_${state.minted}`;
        state.installTokens.set(token, installation.id);
        return json(res, 201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: body?.repositories ?? [] });
      }
      const where = p.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/);
      if (where) {
        const installation = state.installations.find((entry) => entry.repos.some((name) => name.toLowerCase() === where[1].toLowerCase()));
        return installation ? json(res, 200, installationJson(installation)) : json(res, 404, { message: "Not Found" });
      }
      return json(res, 404, { message: `no fake for ${req.method} ${p}` });
    }
    if (isJwt) return json(res, 403, { message: "A JWT cannot do that" });

    // ---- an installation's own endpoints
    if (p === "/installation/repositories") {
      if (installationId === null) return json(res, 403, { message: "Not an installation token" });
      const installation = state.installations.find((entry) => entry.id === installationId);
      return json(res, 200, { total_count: installation.repos.length, repositories: installation.repos.map((full_name) => ({ full_name, name: full_name.split("/")[1] })) });
    }
    const permission = p.match(/^\/repos\/ada\/engine\/collaborators\/([^/]+)\/permission$/);
    if (permission) {
      const role = state.collaborators.get(decodeURIComponent(permission[1]));
      return role ? json(res, 200, { permission: role, role_name: role, user: { login: permission[1] } }) : json(res, 404, { message: "Not Found" });
    }

    // ---- the repository, for either kind of token
    if (p === "/user") return json(res, 200, { login: "ada" });
    if (p === "/user/repos" && req.method === "POST") {
      // Only a person's token makes repositories under their account.
      if (!isOwner) return json(res, 403, { message: "Resource not accessible by integration" });
      if (state.created.some((entry) => entry.name === body.name)) {
        return json(res, 422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] });
      }
      const made = { name: body.name, private: Boolean(body.private), description: body.description ?? null, auto_init: Boolean(body.auto_init) };
      state.created.push(made);
      // auto_init lays down the README commit GitHub would.
      if (made.auto_init) state.seed("main", { "README.md": `# ${made.name}\n` });
      return json(res, 201, {
        full_name: `ada/${made.name}`, name: made.name, html_url: `https://github.com/ada/${made.name}`,
        description: made.description, default_branch: "main", private: made.private, permissions: { push: true },
      });
    }
    if (p === "/user/repos") return json(res, 200, [state.repo, { ...state.repo, full_name: "ada/notes", name: "notes", permissions: { push: false } }]);
    if (p === "/repos/ada/engine") return json(res, 200, state.repo);
    if (p.startsWith("/repos/ada/engine/tarball/")) {
      // GitHub answers with a redirect to codeload; the client must follow it.
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/codeload/${p.split("/").pop()}` });
      return res.end();
    }
    if (p.startsWith("/codeload/")) {
      // The ref's own tree when the fake knows it - a branch name or a commit
      // pushed through the git-data endpoints - so a refill from a push
      // brings back what was pushed. Otherwise the seeded files.
      const at = decodeURIComponent(p.split("/").pop());
      const commit = state.commits.get(state.branches.get(at) ?? at);
      const tree = commit && state.trees.get(commit.tree);
      const files = tree
        ? Object.fromEntries(tree.map((entry) => [entry.path, state.blobs.get(entry.sha)?.content ?? ""]))
        : state.files;
      const tarball = await archive(files, "ada-engine-1234567");
      res.writeHead(200, { "content-type": "application/x-gzip", "content-length": tarball.length });
      return res.end(tarball);
    }
    const ref = p.match(/^\/repos\/ada\/engine\/git\/ref\/heads\/(.+)$/);
    if (ref) {
      const branch = decodeURIComponent(ref[1]);
      const head = state.branches.get(branch);
      return head
        ? json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: head, type: "commit" } })
        : json(res, 404, { message: "Not Found" });
    }
    const commit = p.match(/^\/repos\/ada\/engine\/git\/commits\/([0-9a-f]+)$/);
    if (commit && req.method === "GET") {
      const got = state.commits.get(commit[1]);
      return got ? json(res, 200, { sha: commit[1], tree: { sha: got.tree }, parents: got.parents.map((s) => ({ sha: s })) }) : json(res, 404, {});
    }
    const tree = p.match(/^\/repos\/ada\/engine\/git\/trees\/([0-9a-f]+)$/);
    if (tree && req.method === "GET") {
      const got = state.trees.get(tree[1]);
      return got ? json(res, 200, { sha: tree[1], tree: got, truncated: false }) : json(res, 404, {});
    }
    if (p === "/repos/ada/engine/git/blobs" && req.method === "POST") {
      const content = body.encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
      const id = blobSha(content);
      state.blobs.set(id, { content });
      return json(res, 201, { sha: id });
    }
    if (p === "/repos/ada/engine/git/trees" && req.method === "POST") {
      const base = state.trees.get(body.base_tree) ?? [];
      const byPath = new Map(base.map((entry) => [entry.path, entry]));
      for (const entry of body.tree) {
        if (entry.sha === null) byPath.delete(entry.path);
        else byPath.set(entry.path, { path: entry.path, sha: entry.sha, type: "blob", size: state.blobs.get(entry.sha)?.content.length ?? 0 });
      }
      const id = sha("7");
      state.trees.set(id, [...byPath.values()]);
      return json(res, 201, { sha: id });
    }
    if (p === "/repos/ada/engine/git/commits" && req.method === "POST") {
      const id = sha("c");
      state.commits.set(id, { tree: body.tree, parents: body.parents, message: body.message });
      return json(res, 201, { sha: id });
    }
    if (p === "/repos/ada/engine/git/refs" && req.method === "POST") {
      const branch = body.ref.replace("refs/heads/", "");
      if (state.branches.has(branch)) return json(res, 422, { message: "Reference already exists" });
      state.branches.set(branch, body.sha);
      return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
    }
    const patchRef = p.match(/^\/repos\/ada\/engine\/git\/refs\/heads\/(.+)$/);
    if (patchRef && req.method === "PATCH") {
      state.branches.set(decodeURIComponent(patchRef[1]), body.sha);
      return json(res, 200, { object: { sha: body.sha } });
    }
    // The person's own pull requests, across repositories: what a git host
    // connected with somebody's own token asks for (server/git-hosts).
    // GitHub answers this one in the *issue* shape - no head, no base, and
    // "closed" for a merge - which is why the caller reads each one whole
    // afterwards, and why this fake answers it in that shape rather than
    // the convenient one.
    if (p === "/search/issues" && req.method === "GET") {
      state.searches.push(url.searchParams.get("q") ?? "");
      return json(res, 200, {
        total_count: state.pulls.length,
        items: state.pulls.map((pull) => ({
          number: pull.number,
          title: pull.title ?? null,
          state: pull.state,
          repository_url: `https://api.github.com/repos/${state.repo.full_name}`,
          pull_request: { url: `https://api.github.com/repos/${state.repo.full_name}/pulls/${pull.number}` },
        })),
      });
    }
    if (p === "/repos/ada/engine/pulls" && req.method === "GET") {
      const head = url.searchParams.get("head");
      // Two listings behind one path, as GitHub has it: by head branch (the
      // "is there already one open from this branch" read), and the whole
      // repository's, which is what the fifteen-minute sweep asks for.
      if (head) return json(res, 200, state.pulls.filter((pull) => `ada:${pull.head}` === head && pull.state === "open"));
      const wanted = url.searchParams.get("state") ?? "open";
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const shown = state.pulls
        .filter((pull) => wanted === "all" || (wanted === "closed" ? pull.state === "closed" : pull.state === "open"))
        .slice(0, perPage);
      state.pullListings.push({ state: wanted, perPage, sort: url.searchParams.get("sort"), as: isOwner ? "owner" : "installation" });
      return json(res, 200, shown.map(listed));
    }
    const files = p.match(/^\/repos\/ada\/engine\/pulls\/(\d+)\/files$/);
    if (files && req.method === "GET") {
      const pull = state.pulls[Number(files[1]) - 1];
      if (!pull) return json(res, 404, { message: "Not Found" });
      return json(res, 200, pull.files ?? []);
    }
    if (p === "/repos/ada/engine/pulls" && req.method === "POST") {
      const pull = { number: state.pulls.length + 1, html_url: `https://github.com/ada/engine/pull/${state.pulls.length + 1}`, head: body.head, base: body.base, title: body.title, body: body.body, state: "open" };
      state.pulls.push(pull);
      return json(res, 201, pull);
    }
    const one = p.match(/^\/repos\/ada\/engine\/pulls\/(\d+)$/);
    if (one && req.method === "GET") {
      const pull = state.pulls[Number(one[1]) - 1];
      if (!pull) return json(res, 404, { message: "Not Found" });
      state.pullReads.push(isOwner ? "owner" : installationId !== null ? "installation" : "jwt");
      return json(res, 200, {
        ...pull, mergeable_state: state.mergeableState, additions: 1, deletions: 0, changed_files: 1,
        head: { ref: pull.head }, base: { ref: pull.base }, user: { login: "ada" }, draft: false,
        created_at: new Date().toISOString(), merged_at: null, closed_at: null,
      });
    }
    const merge = p.match(/^\/repos\/ada\/engine\/pulls\/(\d+)\/merge$/);
    if (merge && req.method === "PUT") {
      const pull = state.pulls[Number(merge[1]) - 1];
      if (!pull) return json(res, 404, { message: "Not Found" });
      // A token the App limits cannot merge unless the App may: the App's
      // own (an installation's), and a sign-in through it (a `ghu_` token
      // from GitHub's OAuth). GitHub's words for that, verbatim.
      // A merge is pull requests write *and* contents write, for the
      // commit it makes - GitHub's rule, and the one a half-widened App
      // (pull requests write, contents read) fails.
      const limited = !isOwner || bearer.startsWith("ghu_");
      const may = state.appPermissions.pull_requests === "write" && state.appPermissions.contents === "write";
      if (limited && !may) return json(res, 403, { message: "Resource not accessible by integration" });
      // A personal token narrowed on GitHub's side: its own words, verbatim.
      const tokenMay = state.tokenPermissions.pull_requests === "write" && state.tokenPermissions.contents === "write";
      if (!limited && !tokenMay) return json(res, 403, { message: "Resource not accessible by personal access token" });
      if (state.mergeRefused) return json(res, 405, { message: state.mergeRefused });
      if (pull.state !== "open") return json(res, 405, { message: "Pull Request is not mergeable" });
      pull.state = "closed";
      pull.merged = true;
      pull.merge_method = body?.merge_method ?? "merge";
      return json(res, 200, { merged: true, sha: sha("c"), message: "Pull Request successfully merged" });
    }
    json(res, 404, { message: `no fake for ${req.method} ${p}` });
  });
  return { state, server };
}

/** A real gzipped tarball of `files` under one top-level directory. */
export async function archive(files, top) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cv-tar-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, top, file);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    return await new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-czf", "-", "-C", dir, top]);
      const chunks = [];
      tar.stdout.on("data", (chunk) => chunks.push(chunk));
      tar.on("error", reject);
      tar.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar ${code}`))));
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Start one, point the server's GitHub client at it, and hand back the state. */
export async function startFakeGitHub() {
  const github = fakeGitHub();
  await new Promise((resolve) => github.server.listen(0, "127.0.0.1", resolve));
  process.env.CODERVIBES_GITHUB_API = `http://127.0.0.1:${github.server.address().port}`;
  return github;
}
