#!/usr/bin/env bash
# Usage: create-board.sh <org> <repo>     (needs: gh auth refresh -s project)
# Creates the delivery board (a GitHub Project) with the Status stages the pipeline moves stories through, links it
# to the repo, and sets BOARD_PROJECT. The pipeline App also needs organisation permission Projects: Read and write.
# shellcheck disable=SC2016   # the $ signs are GraphQL variables, not shell ones
set -euo pipefail
ORG="${1:?org}"; REPO="${2:?repo}"
OID=$(gh api graphql -f query='query($o:String!){organization(login:$o){id}}' -f o="$ORG" --jq .data.organization.id)
RID=$(gh api graphql -f query='query($o:String!,$r:String!){repository(owner:$o,name:$r){id}}' -f o="$ORG" -f r="$REPO" --jq .data.repository.id)
P=$(gh api graphql -f query='mutation($o:ID!,$r:ID!){createProjectV2(input:{ownerId:$o,title:"Salesforce delivery",repositoryId:$r}){projectV2{id number url}}}' -f o="$OID" -f r="$RID" --jq .data.createProjectV2.projectV2)
PID=$(jq -r .id <<<"$P"); NUM=$(jq -r .number <<<"$P")
F=$(gh api graphql -f query='query($p:ID!){node(id:$p){... on ProjectV2{field(name:"Status"){... on ProjectV2SingleSelectField{id}}}}}' -f p="$PID" --jq .data.node.field.id)
gh api graphql -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[
  {name:"Ready",color:GRAY,description:"Written, not started"},
  {name:"Building",color:BLUE,description:"Branch and scratch org exist"},
  {name:"In review",color:YELLOW,description:"PR open: CI, review, UI test"},
  {name:"Approved",color:PURPLE,description:"Signed off; merging"},
  {name:"In staging",color:ORANGE,description:"Merged into the sprint; staging regression"},
  {name:"Live",color:GREEN,description:"In production"}]}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}' -f f="$F" >/dev/null
gh variable set BOARD_PROJECT -R "$ORG/$REPO" --body "$NUM"
echo "board $(jq -r .url <<<"$P") (project $NUM); BOARD_PROJECT set."
echo "Next: org settings > GitHub Apps > <pipeline app> > Permissions > Organization: Projects = Read and write; accept on the installation."
echo "Leave the project's built-in workflows off (the pipeline moves cards), except 'Item added to project' -> Ready."
