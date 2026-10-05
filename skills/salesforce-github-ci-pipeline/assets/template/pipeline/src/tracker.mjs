// The tracker: where stories and sprints live (see CONTEXT.md). One interface, two adapters.
//   story(key) -> { key, title, body, state: "OPEN"|"CLOSED", labels[], url }
//   comment(key, text) · done(key, text) · carry(key, sprint, text)
//   sprintStories(sprint) -> [{ key, title, state }] · openSprint(sprint) · closeSprint(sprint)
// Pick with TRACKER=github (default) or TRACKER=jira. Everything Salesforce- or gate-related ignores the tracker.
import { milestoneTitle } from "./conventions.mjs";

export function githubTracker({ gh, ghPages, repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY }) {
  const list = (path) => (ghPages ? ghPages(path) : gh(["api", path]) || []);
  const milestone = (sprint, state = "all") => list(`repos/${repo}/milestones?state=${state}&per_page=100`).find((m) => m.title === milestoneTitle(sprint));
  return {
    name: "github",
    async story(key) {
      const i = gh(["issue", "view", String(key), "--json", "number,title,body,state,labels,url,milestone"]);
      return { key: String(i.number), title: i.title, body: i.body, state: i.state, labels: i.labels.map((l) => l.name), url: i.url, sprint: i.milestone?.title || null };
    },
    async comment(key, text) { gh(["issue", "comment", String(key), "--body", text]); },
    /** Comments oldest first: { author, body, created }. */
    async comments(key) {
      return list(`repos/${repo}/issues/${key}/comments?per_page=100`).map((c) => ({ author: c.user?.login || "", body: c.body || "", created: c.created_at }));
    },
    /** Create or update the one story card comment (found by its marker). */
    async card(key, body, mark) {
      const mine = list(`repos/${repo}/issues/${key}/comments?per_page=100`).find((c) => String(c.body || "").includes(mark));
      if (mine) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${mine.id}`, "-f", `body=${body}`]);
      else gh(["issue", "comment", String(key), "--body", body]);
    },
    async done(key, text) {
      if (text) gh(["issue", "comment", String(key), "--body", text]);
      gh(["issue", "close", String(key), "--reason", "completed"], { allowFail: true });
    },
    async carry(key, sprint, text) {
      gh(["issue", "comment", String(key), "--body", text]);
      gh(["issue", "edit", String(key), "--remove-milestone"], { allowFail: true });
    },
    async sprintStories(sprint) {
      const list = gh(["issue", "list", "--milestone", milestoneTitle(sprint), "--state", "all", "--limit", "200", "--json", "number,title,state"]) || [];
      return list.map((i) => ({ key: String(i.number), title: i.title, state: i.state }));
    },
    async openSprint(sprint) {
      if (!milestone(sprint)) gh(["api", `repos/${repo}/milestones`, "-f", `title=${milestoneTitle(sprint)}`, "-f", `description=Release train ${sprint}`]);
    },
    async closeSprint(sprint) {
      const m = milestone(sprint, "open");
      if (m) gh(["api", "-X", "PATCH", `repos/${repo}/milestones/${m.number}`, "-f", "state=closed"]);
    },
    async assignSprint(key, sprint) { gh(["issue", "edit", String(key), "--milestone", milestoneTitle(sprint)], { allowFail: true }); },
  };
}

/** Plain text from Atlassian Document Format (Jira Cloud descriptions and comments). */
export function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  const inner = (node.content || []).map(adfToText).join("");
  if (node.type === "listItem") return `- ${inner.trim()}\n`;
  if (["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote"].includes(node.type)) return `${inner.trimEnd()}\n\n`;
  return inner;
}
const adfDoc = (text) => ({ type: "doc", version: 1, content: text.split("\n\n").map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });

export function jiraTracker({ fetch = globalThis.fetch, base = process.env.JIRA_BASE_URL, email = process.env.JIRA_EMAIL, token = process.env.JIRA_API_TOKEN }) {
  if (!base || !email || !token) throw new Error("TRACKER=jira needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN");
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  const call = async (method, path, body) => {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method, headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Jira ${method} ${path} failed: ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const isDone = (status) => status?.statusCategory?.key === "done";
  return {
    name: "jira",
    async story(key) {
      const i = await call("GET", `/rest/api/3/issue/${key}?fields=summary,description,status,labels`);
      return { key: i.key, title: i.fields.summary, body: adfToText(i.fields.description).trim(), state: isDone(i.fields.status) ? "CLOSED" : "OPEN", labels: i.fields.labels || [], url: `${base.replace(/\/$/, "")}/browse/${i.key}` };
    },
    async comment(key, text) { await call("POST", `/rest/api/3/issue/${key}/comment`, { body: adfDoc(text) }); },
    /** Comments oldest first; the pipeline's own (posted as the API user) read as "app/pipeline". */
    async comments(key) {
      const all = (await call("GET", `/rest/api/3/issue/${key}/comment?maxResults=100&orderBy=created`))?.comments || [];
      return all.map((c) => ({ author: c.author?.emailAddress === email ? "app/pipeline" : (c.author?.displayName || ""), body: adfToText(c.body), created: c.created }));
    },
    async card(key, body, mark, title) {
      const text = body.replace(mark, "").replace(/```mermaid[\s\S]*?```\n*/g, "").trim();   // Jira draws no Mermaid and shows HTML comments as text
      const all = (await call("GET", `/rest/api/3/issue/${key}/comment?maxResults=100`))?.comments || [];
      const mine = all.find((c) => adfToText(c.body).includes(title));
      if (mine) await call("PUT", `/rest/api/3/issue/${key}/comment/${mine.id}`, { body: adfDoc(text) });
      else await this.comment(key, text);
    },
    async done(key, text) {
      if (text) await this.comment(key, text);
      const { transitions } = await call("GET", `/rest/api/3/issue/${key}/transitions`);
      const t = transitions.find((x) => isDone(x.to?.status ? x.to.status : x.to)) || transitions.find((x) => /done/i.test(x.name));
      if (!t) throw new Error(`No transition to Done for ${key}`);
      await call("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    },
    // Jira moves unfinished issues itself when a sprint is completed; the pipeline only leaves a note.
    async carry(key, sprint, text) { await this.comment(key, text); },
    async sprintStories(sprint) {
      const r = await call("POST", "/rest/api/3/search/jql", { jql: `sprint = "${sprint}"`, fields: ["summary", "status"], maxResults: 200 });
      return (r.issues || []).map((i) => ({ key: i.key, title: i.fields.summary, state: isDone(i.fields.status) ? "CLOSED" : "OPEN" }));
    },
    // Sprints are started, completed and filled in Jira (they trigger the pipeline), not by it.
    async openSprint() {},
    async closeSprint() {},
    async assignSprint() {},
  };
}

export function tracker(io, env = process.env) {
  return (env.TRACKER || "github") === "jira" ? jiraTracker({}) : githubTracker({ gh: io.gh, ghPages: io.ghPages });
}
