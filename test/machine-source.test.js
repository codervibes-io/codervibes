// Where a machine is, from what it says and what e2b says - see
// server/machine-source.js. The setup script sends the marks it found; a
// name that carries none is looked up against the sandboxes this
// installation's e2b key can see, once per half minute, and a machine
// that is neither is a laptop.
import test from "node:test";
import assert from "node:assert/strict";

const source = await import("../server/machine-source.js");

/** A listing that answers like the connector's, counting how often it was asked. */
function fakeE2b(ids, { fail = false } = {}) {
  const calls = [];
  const list = async (key) => {
    calls.push({ key });
    if (fail) throw new Error("e2b answered 503");
    return ids.map((id) => ({ sandboxID: id, templateID: "base", alias: null }));
  };
  return { calls, list };
}

test.beforeEach(() => {
  source.forgetE2b();
  delete process.env.E2B_API_KEY;
});

test("a platform's mark on the machine names it, in the order that a named platform beats a bare container", async () => {
  assert.equal(await source.platformOf({ markers: ["E2B_SANDBOX_ID"] }), "e2b");
  assert.equal(await source.platformOf({ markers: ["NITESHIFT_LIFECYCLE_PROVISION"] }), "niteshift");
  assert.equal(await source.platformOf({ markers: ["NITESHIFT_TASK_ID"] }), "niteshift", "a Niteshift machine past its setup phase still says so");
  // Niteshift rents its sandboxes from e2b, so its machines carry both marks
  // and the order has to break the tie the way the person would: they chose
  // Niteshift, and e2b is the detail underneath it.
  assert.equal(await source.platformOf({ markers: ["E2B_SANDBOX_ID", "NITESHIFT_SANDBOX_ID"] }), "niteshift");
  assert.equal(await source.platformOf({ markers: ["CODESPACES"] }), "codespaces");
  assert.equal(await source.platformOf({ markers: ["CODERVIBES_CONTAINER", "E2B_SANDBOX_ID"] }), "e2b", "the first known mark wins, and the list is ordered so a name beats 'container'");
  assert.equal(await source.platformOf({ markers: ["CODERVIBES_CONTAINER"] }), "container");
  assert.equal(await source.platformOf({ markers: ["SOMETHING_ELSE"] }), "laptop", "a mark nobody knows says nothing");
  assert.equal(await source.platformOf({}), "laptop");
  // What the machine said outright wins over its marks, and is cleaned.
  assert.equal(await source.platformOf({ platform: "Fly", markers: ["E2B_SANDBOX_ID"] }), "fly");
  assert.equal(await source.platformOf({ platform: "laptop", markers: ["E2B_SANDBOX_ID"] }), "e2b", "'laptop' is the absence of an answer, not one");
});

test("with an e2b key, a name that is one of its sandboxes is an e2b machine whatever its environment said - asked once, not per hook", async () => {
  const { calls, list } = fakeE2b(["sbx_abc", "sbx_def"]);
  assert.equal(await source.platformOf({ machine: "sbx_abc" }, { key: "e2b_test", list }), "e2b");
  assert.equal(await source.platformOf({ machine: "adas-laptop" }, { key: "e2b_test", list }), "laptop");
  assert.equal(await source.platformOf({ machine: "sbx_def" }, { key: "e2b_test", list }), "e2b");
  assert.equal(calls.length, 1, "one listing serves every question inside the cache window");
  assert.equal(calls[0].key, "e2b_test");
  // A different key - somebody else's connector - is a different listing.
  const theirs = fakeE2b(["sbx_zzz"]);
  assert.equal(await source.platformOf({ machine: "sbx_zzz" }, { key: "e2b_other", list: theirs.list }), "e2b");
  assert.equal(await source.platformOf({ machine: "sbx_abc" }, { key: "e2b_other", list: theirs.list }), "laptop", "not in their listing");
  assert.equal(theirs.calls.length, 1);
});

test("without a key, or with e2b unreachable, nothing is asked and the machine is what it said", async () => {
  const quiet = fakeE2b(["sbx_abc"]);
  assert.equal(await source.platformOf({ machine: "sbx_abc" }, { key: null, list: quiet.list }), "laptop");
  assert.equal(quiet.calls.length, 0, "no key, no request");

  const down = fakeE2b([], { fail: true });
  assert.equal(await source.platformOf({ machine: "sbx_abc" }, { key: "e2b_test", list: down.list }), "laptop");
  assert.equal(await source.platformOf({ machine: "sbx_abc" }, { key: "e2b_test", list: down.list }), "laptop");
  assert.equal(down.calls.length, 1, "a failure is remembered for the window rather than retried on every hook");
});
