#!/usr/bin/env bash
# Creates or updates the Cognito app client the Atenea gateway signs staff in with: the
# Hosted UI with the authorization code flow and PKCE, in the staff user pool. Running it
# again puts the client back to exactly these settings.
#
#   AWS_PROFILE=<profile> gateway/scripts/cognito-app-client.sh
#
# The client is public (no secret). The gateway is a server and could keep one, but PKCE
# already binds each code to the gateway that asked for it, and a secret would sit in the
# same process memory and environment as the refresh tokens it is meant to protect; it
# would only add a value to rotate. COGNITO_CLIENT_SECRET stays supported for a
# confidential client made by hand (Cognito adds a secret only when a client is created).
#
# It prints the gateway's COGNITO_* values; the client id is not a secret.
set -euo pipefail

: "${AWS_PROFILE:?set AWS_PROFILE to the profile of the account that holds the staff pool}"
export AWS_PROFILE
REGION="${REGION:-mx-central-1}"
POOL_NAME="${POOL_NAME:-Zuri-Staff-prod}"
CLIENT_NAME="${CLIENT_NAME:-atenea-interna}"
PUBLIC_URL="${PUBLIC_URL:-https://ia.iruzlabs.com}"
# Add a federated provider's name here (space-separated) when staff sign in through one.
IDENTITY_PROVIDERS="${IDENTITY_PROVIDERS:-COGNITO}"
# The gateway's absolute session lasts 7 days; a longer refresh token would outlive it.
REFRESH_TOKEN_DAYS="${REFRESH_TOKEN_DAYS:-7}"

fail() { echo "cognito-app-client: $*" >&2; exit 1; }
cognito() { aws cognito-idp --region "$REGION" --output text "$@"; }

PUBLIC_URL="${PUBLIC_URL%/}"
[[ "$PUBLIC_URL" == https://* ]] || fail "PUBLIC_URL must be https (got $PUBLIC_URL)"

echo "Account $(aws sts get-caller-identity --query Account --output text), region $REGION"

POOL_ID="${USER_POOL_ID:-}"
if [[ -z "$POOL_ID" ]]; then
  POOL_ID="$(cognito list-user-pools --max-results 60 --query "UserPools[?Name=='$POOL_NAME'].Id")"
  [[ -n "$POOL_ID" && "$POOL_ID" != "None" ]] || fail "no user pool named $POOL_NAME"
  [[ "$POOL_ID" != *[[:space:]]* ]] || fail "more than one user pool is named $POOL_NAME; set USER_POOL_ID"
fi
echo "User pool $POOL_NAME: $POOL_ID"

read -r -a providers <<<"$IDENTITY_PROVIDERS"
settings=(
  --supported-identity-providers "${providers[@]}"
  --callback-urls "$PUBLIC_URL/auth/callback"
  --logout-urls "$PUBLIC_URL/"
  --allowed-o-auth-flows code
  --allowed-o-auth-scopes openid email profile
  --allowed-o-auth-flows-user-pool-client
  # The Hosted UI signs users in; the gateway only redeems codes and refresh tokens.
  --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH
  --read-attributes email email_verified name
  --token-validity-units AccessToken=minutes,IdToken=minutes,RefreshToken=days
  --access-token-validity 60
  --id-token-validity 60
  --refresh-token-validity "$REFRESH_TOKEN_DAYS"
  --enable-token-revocation
  --prevent-user-existence-errors ENABLED
)

CLIENT_ID="$(cognito list-user-pool-clients --user-pool-id "$POOL_ID" --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId")"
[[ "$CLIENT_ID" != "None" ]] || CLIENT_ID=""
[[ "$CLIENT_ID" != *[[:space:]]* ]] || fail "more than one app client is named $CLIENT_NAME in $POOL_ID"

if [[ -z "$CLIENT_ID" ]]; then
  CLIENT_ID="$(cognito create-user-pool-client --user-pool-id "$POOL_ID" --client-name "$CLIENT_NAME" \
    --no-generate-secret "${settings[@]}" --query 'UserPoolClient.ClientId')"
  echo "Created app client $CLIENT_NAME"
else
  # An update resets every setting it does not name, so it names them all.
  cognito update-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" --client-name "$CLIENT_NAME" \
    "${settings[@]}" --query 'UserPoolClient.ClientId' >/dev/null
  echo "Updated app client $CLIENT_NAME"
fi

read -r DOMAIN CUSTOM_DOMAIN <<<"$(cognito describe-user-pool --user-pool-id "$POOL_ID" --query 'UserPool.[Domain,CustomDomain]')"
if [[ -n "${CUSTOM_DOMAIN:-}" && "$CUSTOM_DOMAIN" != "None" ]]; then
  HOSTED_UI="https://$CUSTOM_DOMAIN"
elif [[ -n "${DOMAIN:-}" && "$DOMAIN" != "None" ]]; then
  HOSTED_UI="https://$DOMAIN.auth.$REGION.amazoncognito.com"
else
  fail "the pool has no Hosted UI domain; add one before the gateway can sign anyone in"
fi

cat <<EOF

Gateway settings (server.env):
COGNITO_DOMAIN=$HOSTED_UI
COGNITO_ISSUER=https://cognito-idp.$REGION.amazonaws.com/$POOL_ID
COGNITO_CLIENT_ID=$CLIENT_ID
PUBLIC_URL=$PUBLIC_URL

SLA's /api/atenea/me must accept ID tokens whose audience is $CLIENT_ID.
EOF
