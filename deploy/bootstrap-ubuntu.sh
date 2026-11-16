#!/usr/bin/env bash
# For a new Ubuntu 24.04 VPS. Read before running as root.
set -euo pipefail
test "$(id -u)" -eq 0 || { echo 'Run as root on your own VPS.' >&2; exit 1; }
. /etc/os-release
test "$ID" = ubuntu && test "$VERSION_ID" = 24.04 || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }
test ! -e /opt/speechcut/current && test ! -e /etc/speechcut.env || {
  echo 'Existing installation found. Follow deploy/VPS.md instead.' >&2; exit 1;
}
case "$(uname -m)" in x86_64) node_arch=x64 ;; aarch64) node_arch=arm64 ;; *) exit 2 ;; esac
if test -e /usr/local/bin/node; then
  test "$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')" = 24 || {
    echo 'Existing Node differs from 24; resolve this before installation.' >&2; exit 1;
  }
fi
apt-get update
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https xz-utils git ffmpeg fonts-dejavu-core sqlite3 util-linux
task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
if ! test -e /usr/local/bin/node; then
  node_version=v24.22.3
  node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
  curl -fSLo "$task_tmp/$node_archive" "https://nodejs.org/dist/$node_version/$node_archive"
  curl -fSLo "$task_tmp/SHASUMS256.txt" "https://nodejs.org/dist/$node_version/SHASUMS256.txt"
  (cd "$task_tmp"; awk -v archive="$node_archive" '$2 == archive' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
  tar -xJf "$task_tmp/$node_archive" --strip-components=1 -C /usr/local
fi
export PATH=/usr/local/bin:/usr/bin:/bin
npm install --global pnpm@11.25.0
if ! command -v caddy >/dev/null; then
  curl -fSLo "$task_tmp/caddy-key.asc" https://dl.cloudsmith.io/public/caddy/stable/gpg.key
  gpg --dearmor < "$task_tmp/caddy-key.asc" > /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fSLo /etc/apt/sources.list.d/caddy-stable.list https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt
  chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
id speechcut >/dev/null 2>&1 || useradd --system --home-dir /var/lib/speechcut --shell /usr/sbin/nologin speechcut
install -d -m 755 /opt/speechcut /opt/speechcut/releases
install -d -m 700 -o speechcut -g speechcut /var/lib/speechcut /var/lib/speechcut/data /var/lib/speechcut/models
install -d -m 700 /var/backups/speechcut
echo 'Base environment installed. Continue docs/INSTALL.md; no credentials, Caddy sites or application services were configured.'
