// The delivery board: a GitHub Project (v2) whose Status column follows each story through the pipeline, moved by
// the same refresh that updates the story card. Off unless repository variable BOARD_PROJECT (the project number)
// is set. Needs the pipeline App's organisation permission "Projects: Read and write"; the Actions token cannot
// reach organisation projects, so the CLI mints an App installation token itself.
import { createSign } from "node:crypto";

export const STAGES = ["Ready", "Building", "In review", "Approved", "In staging", "Live"];

/** Where a story is, from the same facts as its card. */
export function stageOf({ pr = null, approved = false, shipped = null }) {
  if (shipped) return "Live";
  if (!pr) return "Building";
  if (pr.state === "MERGED") return pr.baseRefName === "main" ? "Live" : "In staging";
  if (pr.state === "CLOSED") return "Building";
  return approved ? "Approved" : "In review";
}

/** An installation token for the pipeline App (RS256 JWT -> /app/installations/{id}/access_tokens). */
export async function appToken({ appId, privateKey, repo, fetcher = fetch }) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
  const h = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" };
  const inst = await (await fetcher(`https://api.github.com/repos/${repo}/installation`, { headers: h })).json();
  if (!inst.id) throw new Error(`App not installed on ${repo}`);
  const tok = await (await fetcher(`https://api.github.com/app/installations/${inst.id}/access_tokens`, { method: "POST", headers: h })).json();
  if (!tok.token) throw new Error("could not mint an App token");
  return tok.token;
}

/** Put the story on the board in its stage. `graphql(query, vars)` is the seam (tests pass a fake). */
export async function moveCard({ graphql, org, project, issueNodeId, stage }) {
  const p = await graphql(`query($org:String!,$n:Int!){organization(login:$org){projectV2(number:$n){id
    field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`, { org, n: Number(project) });
  const proj = p.organization?.projectV2;
  if (!proj?.field) throw new Error(`project ${project} has no Status field`);
  const option = proj.field.options.find((o) => o.name === stage);
  if (!option) throw new Error(`Status has no option "${stage}" (needs: ${STAGES.join(", ")})`);
  const added = await graphql(`mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`, { p: proj.id, c: issueNodeId });
  const item = added.addProjectV2ItemById.item.id;
  await graphql(`mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
    { p: proj.id, i: item, f: proj.field.id, o: option.id });
  return { item, stage };
}
