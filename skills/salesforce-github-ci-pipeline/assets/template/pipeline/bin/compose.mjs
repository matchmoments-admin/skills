// The composition root: the one place that picks the adapters behind the pipeline's ports. Policy (pipeline/src)
// sees only what this returns. One of each per process: the code host remembers what it fetched, the trackers the
// comments they edit.
//   runner  CiRunner (runners/): GitHub Actions today
//   host    the code host (github.mjs): PRs, reviews, statuses, check runs, the event log
//   tracker the story tracker (tracker.mjs): GitHub Issues, or Jira (TRACKER=jira)
//   cards   story and PR cards (card.mjs) on the tracker and the code host
import { codeHost } from "../src/github.mjs";
import { actionsRunner } from "../src/runners/github-actions.mjs";
import { tracker as makeTracker, githubTracker } from "../src/tracker.mjs";
import { storyCards } from "../src/card.mjs";

export function compose({ io, env = process.env, sleep, log }) {
  let runner;
  const host = codeHost({ io, env, sleep, log, runUrl: () => runner.runUrl });
  runner = actionsRunner({ io, api: host.api, repo: host.repo, repoUrl: host.repoUrl, env });
  // built on first use: only tracker commands need TRACKER=jira's login
  let made; const tracker = new Proxy({}, { get: (_, k) => (made ||= makeTracker(io))[k], has: (_, k) => k in (made ||= makeTracker(io)) });
  const cards = storyCards({ host, tracker, prTracker: githubTracker({ gh: io.gh, ghPages: io.ghPages }), log });
  return { host, runner, tracker, cards };
}
