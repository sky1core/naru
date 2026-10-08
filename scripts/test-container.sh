#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
if ! apt-get install -y -qq --no-install-recommends xvfb xauth dbus-x11 libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 > /work/artifacts/setup.log 2>&1; then
  cat /work/artifacts/setup.log
  exit 1
fi
chown -R node:node /work
runuser -u node -- npm ci --no-audit --no-fund
runuser -u node -- node -p "require('electron')"
chown root:root node_modules/electron/dist/chrome-sandbox
chmod 4755 node_modules/electron/dist/chrome-sandbox
