#!/bin/sh
# Runs dsh web as the node user. The container is the sandbox boundary, so the
# image offers only the danger-full-access preset (see docker.patch.yml).
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

# First start: seed the data volume with the template home built into the image
# (a web profile that already has ds-bot installed).
if [ ! -d /data/profiles/web ]; then
  mkdir -p /data
  cp -a /opt/dsh-template/. /data/
fi
# A volume keeps the plugin it was seeded with, so a newer image would go on running the
# old ds-bot. Install this image's package through dsh's plugin manager when the profile
# has another one; it runs as root before the ownership pass below, from the image's pnpm
# store. A lockfile written by an older image can make pnpm's supply-chain check want
# registry metadata the image does not carry, so pnpm may go online for what is missing.
# The store sits on another filesystem than the volume, so pnpm copies instead of
# hard-linking. A failed install stops the start rather than serve stale code.
PLUGIN_ID=$(cat /opt/ds-bot/package-id)
if [ "$(cat /data/profiles/web/.ds-bot-package 2>/dev/null || true)" != "$PLUGIN_ID" ]; then
  echo "entrypoint: installing $PLUGIN_ID into the web profile"
  if ! DSH_HOME=/data dsh plugin --profile web add --prefer-offline --package-import-method=copy \
      --store-dir=/root/.local/share/pnpm/store "/opt/ds-bot/$PLUGIN_ID"; then
    echo "entrypoint: could not install $PLUGIN_ID into the web profile" >&2
    exit 1
  fi
  printf '%s\n' "$PLUGIN_ID" > /data/profiles/web/.ds-bot-package
fi
# Existing profiles and restored backups can belong to a previous PUID/PGID.
# Do not follow links into workspace shares or descend into other filesystems.
find -P /data -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
  -exec chown -h node:node -- {} +

mkdir -p /workspace
# Only claim an empty /workspace; a populated share keeps its owners.
if [ -z "$(ls -A /workspace)" ]; then
  chown node:node /workspace
fi

# This dsh release accepts only 127.0.0.1 for --host, so an overlay binds all
# interfaces instead; the container's publish rule is the network boundary.
# DSH_LISTEN_PORT only matters with network_mode: host — published ports
# always map to 3080 inside.
HOST=${DSH_HOST:-0.0.0.0}
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
case "$HOST" in
  0.0.0.0|127.0.0.1) ;;
  *) echo "entrypoint: DSH_HOST must be 0.0.0.0 or 127.0.0.1 (got '$HOST')" >&2; exit 1 ;;
esac
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac
# Server mode is the image behind the Atenea gateway (gateway/README.md). A typo must not
# leave the owner-only features of server.patch.yml switched on, so other values stop here.
SERVER_MODE=${ATENEA_SERVER_MODE:-0}
case "$SERVER_MODE" in
  0) SERVER_PATCH= ;;
  1) SERVER_PATCH=/opt/ds-bot/server.patch.yml ;;
  *) echo "entrypoint: ATENEA_SERVER_MODE must be 0 or 1 (got '$SERVER_MODE')" >&2; exit 1 ;;
esac

# The webserver row's whole config is replaced by a patch, so its bundle values
# (compression on this dsh release) are restated literally.
cat > /tmp/listen.patch.yml <<EOF
- id: webserver
  config:
    host: $HOST
    port: $LISTEN_PORT
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF

# --patch is a dsh option and must precede the app's own flags.
set -- dsh --profile web \
  --patch /opt/ds-bot/docker.patch.yml --patch /tmp/listen.patch.yml \
  ${SERVER_PATCH:+--patch "$SERVER_PATCH"} \
  --no-open "$@"

if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for trusted in $DSH_TRUSTED_HOST; do
    [ -n "$trusted" ] && set -- "$@" --trusted-host "$trusted"
  done
  IFS=$old_ifs
fi
export HOME=/home/node
cd /workspace
if [ "$SERVER_MODE" = 0 ]; then
  exec gosu node "$@"
fi

# Server mode: the gateway trades dsh's launch token for its own owner cookie, so the
# `dsh web:` line goes to a 0600 file in a volume only the gateway also mounts, and the log
# says only that it was written. dsh stays PID 1; its stdout passes through a FIFO that a
# reader copies to the log line by line.
LAUNCH_FILE=${DSH_LAUNCH_URL_FILE:-/run/atenea/dsh-launch-url}
LAUNCH_DIR=$(dirname "$LAUNCH_FILE")
mkdir -p "$LAUNCH_DIR"
chown node:node "$LAUNCH_DIR"
chmod 0700 "$LAUNCH_DIR"
# A file left by the previous start names a token that no longer opens anything.
rm -f "$LAUNCH_FILE"
# The FIFO stays root's, in a private directory: root opens both ends and dsh inherits the
# writing one. Hosts with fs.protected_fifos (Ubuntu's default) refuse even root an O_CREAT
# open of a FIFO someone else owns in a sticky directory such as /tmp.
FIFO_DIR=$(mktemp -d /tmp/dsh-stdout.XXXXXX)
FIFO=$FIFO_DIR/stdout
mkfifo -m 0600 "$FIFO"
(
  # Opening waits for dsh to open the writing end; the name is not needed after that.
  exec 3<"$FIFO"
  rm -rf "$FIFO_DIR"
  umask 077
  while IFS= read -r line <&3 || [ -n "$line" ]; do
    case $line in
      'dsh web: http'*)
        printf '%s\n' "$line" > "$LAUNCH_FILE.tmp"
        chown node:node "$LAUNCH_FILE.tmp"
        mv -f "$LAUNCH_FILE.tmp" "$LAUNCH_FILE"
        echo "dsh web: ready; launch URL written to $LAUNCH_FILE" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
) &
exec gosu node "$@" >"$FIFO"
