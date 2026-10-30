import { test, expect, Page, Route } from "@playwright/test";
import { login, openPath } from "../../../e2e/support/login";

// A fake scratch org on Salesforce's three hosts. What release 2027-w03 saw (run 41001925070): the front door lands on
// Setup Home, Salesforce's Setup-domain probe moves the page to <my domain>.my.salesforce-setup.com with
// ?SetupDomainProbePassed=true&SetupDomainReload=1, and a Lightning path asked of that host ends on Setup Home.
// Redirects are inline location.replace(): page.route sees only the first URL of an HTTP redirect (the rest would go to
// the real hosts), and page.goto treats both alike (it resolves on the page that loads).
const MY = "https://acme-dev-ed.scratch.my.salesforce.com";
const LX = "https://acme-dev-ed.scratch.lightning.force.com";
const SU = "https://acme-dev-ed.scratch.my.salesforce-setup.com";
const PROBED = "?SetupDomainProbePassed=true&SetupDomainReload=1";
const SETUP_HOME = `${SU}/lightning/setup/SetupOneHome/home${PROBED}`;
const REPORT = "/lightning/r/Report/00O000000000001AAA/view";
const PERMSET = "/lightning/r/PermissionSet/0PS000000000001AAA/view";

delete process.env.SCRATCH_ALIAS;
process.env.SF_FRONTDOOR_URL = `${MY}/secur/frontdoor.jsp?otp=fake`;

interface Org {
  landing?: string; // where the front door lands (Salesforce: Setup Home)
  probeMs?: number; // when the probe moves a Setup page to the Setup domain after it shows (0: before it shows)
  keepQuery?: boolean; // the Setup domain keeps ?SetupDomainProbePassed=true&SetupDomainReload=1 in the URL
  bounces?: number; // how many times the Lightning host redirects a page to Setup Home instead of the path asked for
  bounceAfterLoad?: string; // this path on the Lightning host loads, then is sent to Setup Home once (a client-side probe)
}

async function fakeOrg(page: Page, org: Org = {}) {
  const asked: string[] = [];
  let bounces = org.bounces ?? 0, lateBounce = org.bounceAfterLoad;
  const send = (route: Route, body: string, head = "") =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head>${head}</head><body><nav aria-label="Global">Salesforce</nav>${body}</body></html>` });
  const to = (route: Route, location: string) =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><script>location.replace(${JSON.stringify(location)})</script>` });
  // every request: the fake is the whole network
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const origin = u.origin, path = u.pathname, setup = path.startsWith("/lightning/setup/");
    if (![MY, LX, SU].includes(origin)) return route.abort();
    if (route.request().resourceType() !== "document") return route.fulfill({ status: 204 });
    asked.push(`${origin}${path}`);
    if (origin === MY && path === "/secur/frontdoor.jsp") return to(route, `${MY}${org.landing ?? "/lightning/setup/SetupOneHome/home"}`);
    if (origin === MY && setup) {
      const probe = `location.replace(${JSON.stringify(SU + path + PROBED)})`;
      return org.probeMs ? send(route, "<h1>Setup Home</h1>", `<script>setTimeout(() => { ${probe} }, ${org.probeMs})</script>`) : to(route, SU + path + PROBED);
    }
    if (origin === MY) return to(route, `${LX}${path}${u.search}`); // the front-door host sends Lightning paths on itself
    if (origin === SU && setup) return send(route, "<h1>Setup</h1>", u.search && !org.keepQuery ? `<script>setTimeout(() => history.replaceState(null, "", location.pathname), 300)</script>` : "");
    if (origin === SU) return to(route, SETUP_HOME);
    if (origin === LX && path === PERMSET) return to(route, `${SU}/lightning/setup/PermSets/page?address=%2F0PS000000000001`); // shown in Setup
    if (origin === LX && bounces > 0) { bounces--; return to(route, SETUP_HOME); }
    if (origin === LX && path === lateBounce) {
      lateBounce = undefined;
      return send(route, `<h1>${path}</h1>`, `<script>addEventListener("load", () => setTimeout(() => location.replace(${JSON.stringify(SETUP_HOME)}), 500))</script>`);
    }
    return send(route, `<h1>${path}</h1>`);
  });
  return { asked };
}

test("the release's failure: the probe moved the page to the Setup domain before openPath, which still lands on the path", async ({ page }) => {
  const { asked } = await fakeOrg(page, { probeMs: 0 });
  await login(page);
  await openPath(page, REPORT);
  expect(page.url()).toBe(`${LX}${REPORT}`);
  await expect(page.getByRole("heading", { name: REPORT })).toBeVisible();
  expect(asked).toContain(`${MY}${REPORT}`); // asked of the front-door host the session started on, never the Setup domain
});

test("login waits out a probe that comes after Setup Home shows, so the page is settled when the spec starts", async ({ page }) => {
  await fakeOrg(page, { probeMs: 1_500 });
  await login(page);
  const settled = page.url();
  expect(new URL(settled).origin).toBe(SU);
  await page.waitForTimeout(2_000);
  expect(page.url()).toBe(settled); // nothing still pending
});

test("login settles on a stable Setup Home even when Salesforce keeps the probe's query", async ({ page }) => {
  await fakeOrg(page, { probeMs: 0, keepQuery: true });
  const t = Date.now();
  await login(page);
  expect(Date.now() - t).toBeLessThan(6_000); // not the 10 s upper bound
  expect(page.url()).toBe(SETUP_HOME);
});

test("openPath checks where it landed: sent to Setup Home once, it asks for the path again", async ({ page }) => {
  const { asked } = await fakeOrg(page, { probeMs: 0, bounces: 1 });
  await login(page);
  await openPath(page, "/lightning/o/Account/list?filterName=__Recent");
  expect(page.url()).toBe(`${LX}/lightning/o/Account/list?filterName=__Recent`);
  expect(asked.filter((a) => a === `${LX}/lightning/o/Account/list`)).toHaveLength(2);
});

test("a bounce after the page loaded (login did not see the probe pass) is caught too", async ({ page }) => {
  await fakeOrg(page, { landing: "/lightning/page/home", bounceAfterLoad: REPORT });
  await login(page);
  await openPath(page, REPORT);
  expect(page.url()).toBe(`${LX}${REPORT}`);
  await page.waitForTimeout(1_000);
  expect(page.url()).toBe(`${LX}${REPORT}`);
});

test("an org that never probes pays the late watch once per login, not on every openPath", async ({ page }) => {
  await fakeOrg(page, { landing: "/lightning/page/home" });
  await login(page);
  await openPath(page, REPORT);
  const t = Date.now();
  await openPath(page, "/lightning/o/Account/list");
  expect(Date.now() - t).toBeLessThan(1_500);
  expect(page.url()).toBe(`${LX}/lightning/o/Account/list`);
});

test("sent to Setup Home every time, openPath fails and says so, instead of leaving the spec on the wrong page", async ({ page }) => {
  await fakeOrg(page, { probeMs: 0, bounces: 5 });
  await login(page);
  await expect(openPath(page, REPORT)).rejects.toThrow(/sent the page to Setup .*\/lightning\/r\/Report\/00O000000000001AAA\/view/);
});

test("a page Salesforce shows in Setup (a permission set record) is not a bounce", async ({ page }) => {
  await fakeOrg(page, { probeMs: 0 });
  await login(page);
  await openPath(page, PERMSET);
  expect(page.url()).toBe(`${SU}/lightning/setup/PermSets/page?address=%2F0PS000000000001`);
});

test("a Setup path is opened, and lands on the Setup domain", async ({ page }) => {
  await fakeOrg(page, { probeMs: 0 });
  await login(page);
  await openPath(page, "/lightning/setup/ObjectManager/home");
  expect(new URL(page.url()).origin + new URL(page.url()).pathname).toBe(`${SU}/lightning/setup/ObjectManager/home`);
});
