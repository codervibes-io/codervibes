// Which sign-in this installation has, for the half of the console that only
// needs to know whether there is one.
//
// Two lines that could have stayed in auth.js, and are here because of what
// auth.js is: the Firebase web SDK's boot, the hosted project's identifiers,
// and three hundred lines of sign-in flow. api.js - which every page of every
// edition calls - imported all of that to ask one question, "does this call
// carry a token", whose answer on a local installation is always no. That put
// codervibes.io's Firebase configuration into the local edition's module
// graph, and so into the open-source repository cut from it
// (scripts/cut-local.mjs), where somebody else's project identifiers have no
// business being.
//
// So the flag lives here, api.js reads it here, and auth.js is loaded only
// when the answer is yes.
export const authMode = { mode: "local" };

/** Whether calls carry an ID token, which is the only thing api.js needs to know. */
export const isFirebase = () => authMode.mode === "firebase";
