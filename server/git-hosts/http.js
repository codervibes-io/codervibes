// One JSON call to a git host, and the one refusal a person can act on.
//
// Three hosts, three dialects, and the same four things that go wrong: the
// token is not accepted, the token cannot see that repository, the host is
// rate-limiting, or the host is simply not there. Each of those reaches a
// person as a sentence naming the host and saying what to do about it,
// because the place it is read is a form with a box in it - "401" in a form
// is a bug report, not an answer.
//
// The host's own words are kept when it sent any (`message`, or GitLab's
// `error`): they are often the useful half ("Token is expired"), and
// inventing a paraphrase of a message the host already wrote would be one
// more thing to keep true.
//
// It imports nothing: the three hosts import this, so anything it imported
// back would be a cycle through the module that is meant to be the leaf.

/** What a host refused, with the status it refused with. */
export class HostError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "HostError";
    this.status = status;
  }
}

/** The host's own sentence, whichever field it wrote it in. */
function saidBy(body) {
  if (!body || typeof body !== "object") return null;
  // `message` is GitHub's and GitLab's; `error.message` is Bitbucket's, and
  // `error` alone is what an OAuth-shaped refusal writes.
  const said =
    body.message ?? body.error?.message ?? (typeof body.error === "string" ? body.error : null) ?? body.error_description ?? body.errors?.[0]?.message ?? null;
  const text = typeof said === "string" ? said.trim() : null;
  return text && text.length < 200 ? text : null;
}

/**
 * Why a call was refused, said to the person who pasted the token.
 *
 * `hint` is the host's own line about what the token has to be able to do,
 * which is the whole of what a 401 or a 403 is asking for.
 */
function refusal({ label, hint }, status, body) {
  const said = saidBy(body);
  const tail = said ? ` It said: ${said}` : "";
  if (status === 401) return `${label} did not accept that token. ${hint}${tail}`;
  if (status === 403) return `${label} accepted the token but refused the request - it is probably missing a scope. ${hint}${tail}`;
  if (status === 404) return `${label} has no such repository or pull request, or this token cannot see it.${tail}`;
  if (status === 429) return `${label} is rate-limiting this token. Try again in a few minutes.${tail}`;
  return `${label} answered ${status}.${tail}`;
}

/**
 * A GET of JSON as one host, or a HostError saying why not.
 *
 * `host` is the host module itself rather than its name, so the sentence a
 * refusal carries is the host's own label and token hint and there is no
 * second table mapping one to the other.
 */
export async function ask(url, { host, headers = {}, signal = undefined } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal });
  } catch (err) {
    throw new HostError(`${host.label} could not be reached: ${err.message}`, null);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A host that answered HTML - a proxy, a login page - said nothing this
    // can quote, and the status is the whole of what is known.
  }
  if (!res.ok) throw new HostError(refusal(host, res.status, body), res.status);
  return body;
}

/** A moment as this app keeps them: milliseconds, or null for "the host did not say". */
export const msOf = (iso) => (iso ? Date.parse(iso) || null : null);
