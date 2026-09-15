// The one line a person runs to stand a LiteLLM proxy up, on its own.
//
// It is a template string with nothing behind it, and it lives apart from
// litellm-setup-script.js - which writes the script that line fetches -
// because the two have different weights. The setup script is ~470 lines of
// Fly, Kubernetes, Docker and pip recipe, and it exists to answer one route:
// `GET /litellm.sh`. The line exists to be printed on the Connectors page.
//
// harnesses.js wanted only the line, and importing the recipe to get it made
// the recipe part of the local edition's closure: scripts/cut-local.mjs walks
// from server/local.js, and every file it reaches is copied into the
// published open-source repository. That edition serves no /litellm.sh, so
// the recipe was carried, read by nobody, into a repo whose readers would
// reasonably think it ran. Splitting the line out is what makes the walk stop
// here instead.
//
// So: nothing imported, and nothing to import. If this file ever needs
// something, that is the signal that the split has stopped paying.

/** The one line a person runs, for the page. */
export const litellmCommand = ({ origin, token, where = null }) =>
  `curl -fsSL ${origin}/litellm.sh | sh -s -- ${token}${where ? ` --${where}` : ""}`;
