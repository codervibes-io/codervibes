// A name for an executor nobody named.
//
// Naming a thing is the first field of every dialog that makes one, and it
// is the field people stall on: an agent that will be one of four on the
// account does not need to be *called* anything in particular, and the
// names that come out of stalling - "test", "agent 2", "Claude Code" for
// the third time - are the ones that make a list unreadable later. So the
// name is optional now, and what fills it in is an adjective and an animal:
// "running elephant", "flaming monkey".
//
// Two words, not a hex id, because the whole point of a name here is to be
// said out loud - "the flaming monkey opened that one" - and because the
// list on the Executors page is read by a person picking a row out of
// several. A pair is memorable and a suffix is not.
//
// The words are deliberately dull-safe: no proper nouns, nothing that lands
// on a person or a place, nothing that reads as an insult when it turns up
// beside somebody's name in a pull request. 40 x 40 is 1600 pairs, which is
// far more than the 40 agents an account may hold, so a collision is a
// retry rather than a design problem.
import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "running", "flaming", "gentle", "restless", "cheerful", "midnight", "velvet", "brisk",
  "clever", "wandering", "stubborn", "dizzy", "plucky", "thunderous", "quiet", "glorious",
  "tangled", "bold", "humming", "patient", "rowdy", "sleepy", "sunlit", "wily",
  "dapper", "rusty", "nimble", "roaring", "curious", "frosty", "lucky", "moonlit",
  "prickly", "solemn", "spry", "vaulting", "wistful", "zealous", "amber", "drifting",
];

const ANIMALS = [
  "elephant", "monkey", "otter", "badger", "heron", "marmot", "walrus", "gecko",
  "lemur", "ferret", "magpie", "narwhal", "ocelot", "pangolin", "puffin", "raccoon",
  "salamander", "tapir", "vulture", "wombat", "yak", "armadillo", "bison", "capybara",
  "dingo", "egret", "falcon", "gibbon", "hedgehog", "ibis", "jackal", "kestrel",
  "lynx", "mongoose", "newt", "osprey", "quokka", "stoat", "toucan", "weasel",
];

/** How many pairs to draw before giving up on chance and counting instead. */
const TRIES = 200;

const pick = (words) => words[randomInt(words.length)];

/**
 * A name no executor on this account has yet.
 *
 * `taken` is the names it must not be - the account's agents, or its
 * harnesses - compared without case, because "Flaming Monkey" and "flaming
 * monkey" are the same row to a person reading the list even though the
 * uniqueness check would let both through.
 *
 * Chance first, and a numbered pair once chance has stopped paying: the
 * fallback exists so this function always returns a name. It cannot be
 * reached with the agent limits this app has, and if the limits ever rise
 * past 1600, "running elephant 2" is still a name somebody can say.
 *
 * @param {Iterable<string>} [taken]
 * @returns {string}
 */
export function funName(taken = []) {
  const used = new Set([...taken].filter(Boolean).map((name) => String(name).trim().toLowerCase()));
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
    if (!used.has(name)) return name;
  }
  const base = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`;
    if (!used.has(name)) return name;
  }
}

/** The words themselves, for the test that checks they stay safe to put beside somebody's name. */
export const WORDS = { adjectives: ADJECTIVES, animals: ANIMALS };
