#!/bin/bash
# Usage: make-ci-cert.sh <repo-dir> <contact-email>
# Creates the CI login for GitHub -> Salesforce (JWT bearer, no password):
#   secrets/ci.key, secrets/ci.crt                    (private key stays local and in a GitHub secret only)
#   devhub-setup/main/default/connectedApps/Pipeline_CI.connectedApp-meta.xml
#   devhub-setup/main/default/permissionsets/Pipeline_CI.permissionset-meta.xml
# Prints the consumer key to store as SF_CI_CONSUMER_KEY. Then deploy devhub-setup/ to production and ASSIGN the
# Pipeline_CI permission set to the CI user: the assignment pre-authorizes the app (it is data, not metadata).
set -euo pipefail
REPO="${1:?repo dir}"; EMAIL="${2:?contact email}"
cd "$REPO"
mkdir -p secrets devhub-setup/main/default/connectedApps devhub-setup/main/default/permissionsets
grep -qx "secrets/" .gitignore 2>/dev/null || echo "secrets/" >> .gitignore
if [ ! -f secrets/ci.key ]; then
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=pipeline-ci" -keyout secrets/ci.key -out secrets/ci.crt 2>/dev/null
  echo "created secrets/ci.key and secrets/ci.crt (valid 2 years)"
fi
CERT=$(sed '/-----/d' secrets/ci.crt | tr -d '\n')
KEY_FILE=secrets/consumer-key.txt
[ -f "$KEY_FILE" ] || { echo "3MVG$(openssl rand -hex 40)" > "$KEY_FILE"; }
CONSUMER=$(cat "$KEY_FILE")
cat > devhub-setup/main/default/connectedApps/Pipeline_CI.connectedApp-meta.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
    <contactEmail>${EMAIL}</contactEmail>
    <label>Pipeline CI</label>
    <oauthConfig>
        <callbackUrl>http://localhost:1717/OauthRedirect</callbackUrl>
        <certificate>${CERT}</certificate>
        <consumerKey>${CONSUMER}</consumerKey>
        <isAdminApproved>true</isAdminApproved>
        <isConsumerSecretOptional>false</isConsumerSecretOptional>
        <scopes>Api</scopes>
        <scopes>Web</scopes>
        <scopes>RefreshToken</scopes>
    </oauthConfig>
    <oauthPolicy>
        <ipRelaxation>BYPASS</ipRelaxation>
        <refreshTokenPolicy>infinite</refreshTokenPolicy>
    </oauthPolicy>
    <permissionSetName>Pipeline CI</permissionSetName>
</ConnectedApp>
EOF
cat > devhub-setup/main/default/permissionsets/Pipeline_CI.permissionset-meta.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Pre-authorizes the Pipeline CI connected app for the user that runs the pipeline.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Pipeline CI</label>
</PermissionSet>
EOF
echo "wrote the connected app and permission set under devhub-setup/"
echo "SF_CI_CONSUMER_KEY=$CONSUMER   (also in $KEY_FILE)"
cat <<'EOF'
Next:
  sf project deploy start -o <prod> -d devhub-setup
  sf org assign permset --name Pipeline_CI -o <prod> --on-behalf-of <ci-user>
  sf org login jwt --client-id <SF_CI_CONSUMER_KEY> --jwt-key-file secrets/ci.key --username <ci-user> --instance-url https://login.salesforce.com
  (a new connected app can take a few minutes before the JWT login works)
If the deploy rejects the generated <consumerKey>, delete that line, deploy again, and copy the key Salesforce
generates (Setup > App Manager > Pipeline CI > View > Manage Consumer Details) into secrets/consumer-key.txt.
EOF
