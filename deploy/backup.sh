#!/bin/sh
set -eu
umask 077
backup_dir=/var/backups/speechcut
mkdir -p "$backup_dir"
backup_path="$backup_dir/$(date -u +%Y%m%dT%H%M%SZ).sqlite"
/usr/bin/sqlite3 /var/lib/speechcut/data/editor.sqlite ".backup '$backup_path'"
test "$(/usr/bin/sqlite3 "$backup_path" 'PRAGMA integrity_check')" = ok
find "$backup_dir" -type f -name '*.sqlite' -mmin +10080 -delete
