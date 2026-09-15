// What a pull request's words say about other pull requests, and nothing else.
//
// A pull request's body is words somebody wrote, and no record here keeps
// words (pulls.js, the essay at the top). But the body is also where a host
// writes the one fact that says what became of an earlier pull request:
// press Revert on GitHub and the new pull request's body reads "Reverts
// owner/repo#412", and GitLab and Bitbucket write the same sentence with
// their own punctuation. A number is an id, not a sentence, so the numbers
// come out here - at the edge, where the body already is - and the body
// itself goes no further.
//
// This was repo-sources/github.js's, and it was never about GitHub: the
// three hosts all write `#412`, and a `git revert`'s message is git's rather
// than any host's. It lives here because repo-sources/github.js is the App's
// half of the world - installation tokens, the tarball import, the manifest
// - and none of that has anything to do with reading a number out of a
// sentence. That module re-exports these, so everything that called them
// there still does.
//
// A leaf: it imports nothing, and `server/repo-sources/github.js` is on the
// local edition's deny list while this is not.

/** How many mentioned numbers one pull request can carry. Past this it is a changelog, not a reference. */
const MAX_MENTIONS = 20;

/** The pull request numbers a title and a body name, in the order first seen. Numbers only. */
export function mentionsIn(...parts) {
  const out = [];
  for (const match of parts.filter(Boolean).join("\n").matchAll(/#(\d{1,7})\b/g)) {
    const number = Number(match[1]);
    if (number > 0 && !out.includes(number) && out.length < MAX_MENTIONS) out.push(number);
  }
  return out;
}

/** The pull request this one says it undoes - GitHub's own words for it, "Reverts owner/repo#412". */
export function revertsIn(...parts) {
  // The repository before the `#` may be a path several segments deep: a
  // GitLab project can sit inside two groups, and its own Revert writes the
  // whole of it.
  const found = /reverts\s+(?:[\w.-]+(?:\/[\w.-]+)+)?#(\d{1,7})\b/i.exec(parts.filter(Boolean).join("\n"));
  return found ? Number(found[1]) : null;
}

/** The commit a `git revert` message names: "This reverts commit <sha>". A sha, not the message. */
export function revertsCommitIn(message) {
  return /this reverts commit ([0-9a-f]{7,40})/i.exec(String(message ?? ""))?.[1] ?? null;
}
