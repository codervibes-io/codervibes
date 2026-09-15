// What kinds of repository a repo's files can come from - the names alone.
//
// index.js holds the source modules themselves, and each of them is a
// client for somebody else's service. Asking "is this repo's files somewhere
// we know how to reach?" is a question about the *kind*, and the registry
// asks it about every record it reads - so the answer lives here, where it
// costs nothing but a string comparison, and index.js re-exports it for the
// callers that were already asking it there.
//
// Adding a source is a file in this directory, a line in index.js's SOURCES
// and the same kind here; a test holds the two lists to each other.

/** The kinds index.js has a source module for. */
export const SOURCE_KINDS = ["github"];

/** Does anything here know how to hold this repo's files? */
export const hasSource = (repo) => SOURCE_KINDS.includes(repo?.source?.kind);

/**
 * Does this repo have a repository its files can go back to?
 *
 * The other kind is a repo from before repositories were the point:
 * made from a template, or copied from one that was (`source.kind` "copy"),
 * with its files on its machine and nowhere else. Such a repo can be
 * opened and worked in, but nothing here can refill its machine, push its
 * work anywhere, or let go of its only copy - and every place that would
 * asks this first, so the refusal says why rather than failing somewhere
 * deeper. It stops being one when the owner exports it (repository.js).
 */
export const hasRepository = (repo) => hasSource(repo) && Boolean(repo.source.repo);
