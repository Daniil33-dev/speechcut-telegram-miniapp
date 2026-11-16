#!/bin/sh
set -eu
release_path="$(realpath "$1")"
case "$release_path" in /opt/speechcut/releases/*) ;; *) exit 2 ;; esac
test -f "$release_path/.next/BUILD_ID"
test -f "$release_path/package.json"
if [ -L /opt/speechcut/current ]; then
  previous_path="$(readlink -f /opt/speechcut/current)"
  ln -sfn "$previous_path" /opt/speechcut/previous
fi
ln -sfn "$release_path" /opt/speechcut/current.next
mv -Tf /opt/speechcut/current.next /opt/speechcut/current
systemctl restart speechcut-web speechcut-worker
