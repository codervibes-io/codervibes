// The made-up name an executor gets when nobody gives it one.
//
// The bugs this file exists to catch are the quiet ones: a generator that
// hands the same name to two agents on an account where names must be
// unique, one that returns nothing when the words run out, and a word list
// that grows a word nobody wants printed beside a colleague's name in a
// pull request.
import test from "node:test";
import assert from "node:assert/strict";

import { funName, WORDS } from "../server/agent-names.js";

test("a name is two lowercase words a person can say, an adjective and an animal", () => {
  for (let i = 0; i < 200; i += 1) {
    const name = funName();
    assert.match(name, /^[a-z]+ [a-z]+$/, name);
    const [adjective, animal] = name.split(" ");
    assert.ok(WORDS.adjectives.includes(adjective), `${adjective} is not one of the adjectives`);
    assert.ok(WORDS.animals.includes(animal), `${animal} is not one of the animals`);
  }
});

test("a name is never one already taken", () => {
  // An account's names must be unique, and the check that enforces that
  // throws - so a generator that can return a taken name is an invite that
  // fails for a reason the person did nothing to cause.
  const taken = new Set();
  for (let i = 0; i < 300; i += 1) {
    const name = funName(taken);
    assert.ok(!taken.has(name), `${name} was handed out twice`);
    taken.add(name);
  }
});

test("a name taken in another case is still taken", () => {
  // "Flaming Monkey" and "flaming monkey" are the same row to somebody
  // reading the list, even though the uniqueness check would let both
  // through.
  const shouted = [...WORDS.adjectives].flatMap((adjective) => WORDS.animals.map((animal) => `${adjective} ${animal}`.toUpperCase()));
  assert.match(funName(shouted), /^[a-z]+ [a-z]+ 2$/, "every pair is taken, in capitals");
});

test("every pair being taken is a numbered name, not an empty one or a hang", () => {
  // Unreachable with the limits this app has - 1600 pairs against at most
  // 40 agents - but a generator that can return undefined puts an agent
  // called "undefined" on somebody's list, which is worse than "running
  // elephant 2".
  const every = [];
  for (const adjective of WORDS.adjectives) {
    for (const animal of WORDS.animals) every.push(`${adjective} ${animal}`);
  }
  const name = funName(every);
  assert.match(name, /^[a-z]+ [a-z]+ 2$/, name);
  assert.match(funName([...every, name]), /^[a-z]+ [a-z]+ [23]$/);
});

test("the words stay safe to print beside a colleague's name", () => {
  // The name lands in a pull request, in the room's chat and on the
  // Executors list, where it sits next to the people who work here. So:
  // lowercase single words only, no proper nouns, and nothing that reads as
  // a remark about whoever is standing near it.
  for (const word of [...WORDS.adjectives, ...WORDS.animals]) {
    assert.match(word, /^[a-z]+$/, `${word} is not one lowercase word`);
    assert.ok(word.length >= 3 && word.length <= 12, `${word} is an awkward length for a name said out loud`);
  }
  assert.equal(new Set(WORDS.adjectives).size, WORDS.adjectives.length, "a repeated adjective is a name drawn twice as often");
  assert.equal(new Set(WORDS.animals).size, WORDS.animals.length);
  // Enough pairs that the account limits cannot exhaust them - see the
  // numbered fallback above for what happens if that ever stops being true.
  assert.ok(WORDS.adjectives.length * WORDS.animals.length >= 1000);
});

test("the drawing is not stuck on one pair", () => {
  // A generator that ignores its randomness passes every test above and
  // names every agent on the account the same thing.
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(funName());
  assert.ok(seen.size > 50, `only ${seen.size} distinct names in 200 draws`);
});
