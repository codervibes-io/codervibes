// The one token an account's own setups report on, and the file that uses it.
//
// See server/ingest-token.js. This is what the Executors page hands over
// instead of a wizard: this app does not start anybody's agent, so the whole
// of connecting one is a file and a token - `/setup.sh`, which is public
// because it holds no secret, and the token, which is the account's.
//
// `/healthz` is here too, for want of anywhere better: it is the other route
// that answers before anybody has signed in, and it says nothing about any
// store on purpose - a health check that reads the database turns a slow
// database into a restart loop.
import * as ingestToken from "../ingest-token.js";
import * as harnesses from "../harnesses.js";
import { setupScript } from "../setup-script.js";
import { publicOrigin } from "../public-url.js";

export function mount(app, scope) {
  const { wrap, requireViewer, requireUser } = scope;

  // For whatever runs this - a Kubernetes probe, a load balancer, a person
  // with curl: the process is up and answering. Nothing about its stores.
  app.get("/healthz", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  // The setup script: `curl -fsSL <origin>/setup.sh | sh -s -- <token>` is the
  // whole of connecting a machine (server/setup-script.js). Public, because it
  // holds no secret - the token is its argument - and built per request only
  // so that it names the origin it was fetched from.
  //
  // What it carries - a token, this app's tools - is the installation's
  // answer rather than this route's: an installation that authenticates
  // nobody and has no connected services serves the same script with both
  // dialled off (scope.js `setup`, setup-script.js).
  app.get("/setup.sh", (req, res) => {
    res.type("text/x-shellscript; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    res.send(setupScript({ origin: publicOrigin(req), ...scope.setup }));
  });

  /**
   * The account's token and the steps that use it.
   *
   * Minting on a GET is deliberate: the panel exists to hand somebody a token,
   * and a first visit that showed "you have none, press here" would be one
   * press in front of the only thing anybody came for. A token minted earlier
   * cannot be shown again - the row keeps its hash - so the answer carries
   * `token: null` and the steps show a placeholder until it is rotated.
   */
  app.get("/api/ingest", requireViewer, wrap(async (req, res) => {
    // A visitor reading the demo has no account to mint for, and the panel
    // is on the page they are looking at: it gets the sample token
    // (ingest-token.js `DEMO_TOKEN`), said to be one, so the line reads as it
    // would for them once signed in. `requireViewer` rather than `requireUser`
    // for exactly this case - a signed-out caller with no demo open is still
    // refused, below, the way `requireUser` would have.
    if (!req.cv.user) {
      if (!scope.demoOpen(req)) return res.status(401).json({ error: "Sign in to continue", signInRequired: true });
      const { token, mintedAt, demo } = ingestToken.sample();
      return res.json({ mintedAt, token, demo, connect: harnesses.connectYourOwn({ origin: publicOrigin(req), token }) });
    }
    // An installation whose setup line carries no token has none to mint and
    // nobody to mint it for (edition.js): the answer is the bare line, and
    // the panel draws the same way from it. Minting here would be this app
    // inventing a credential its own script does not use - a secret nobody
    // asked for, that protects nothing, on a page that hands it over.
    if (scope.setup.token === "none") {
      return res.json({ mintedAt: null, token: null, connect: harnesses.connectYourOwn({ origin: publicOrigin(req), token: null }) });
    }
    const { token, mintedAt } = await ingestToken.ensure(req.cv.user);
    res.json({
      mintedAt,
      token,
      connect: harnesses.connectYourOwn({ origin: publicOrigin(req), token }),
    });
  }));

  // A new one, and every setup on the old one goes quiet - which is what
  // somebody rotating a leaked token is asking for.
  app.post("/api/ingest/rotate", requireUser, wrap(async (req, res) => {
    // And the same where there was never one: rotating nothing mints a
    // first token, which is the one thing the branch above exists to not do.
    if (scope.setup.token === "none") {
      return res.status(404).json({ error: "This CoderVibes issues no tokens - its setup line carries none." });
    }
    const { token, mintedAt } = await ingestToken.mint(req.cv.user);
    res.json({
      mintedAt,
      token,
      connect: harnesses.connectYourOwn({ origin: publicOrigin(req), token }),
    });
  }));
}
