#!/bin/sh
# Run as root against a stopped home volume. GNU find/chown are in the box.
set -eu
: "${HOME_ROOT:=/home/agent}"
: "${OLD_UID:?Set the previous image UID}"
: "${OLD_GID:?Set the previous image GID}"
: "${NEW_UID:?Set the target image UID}"
: "${NEW_GID:?Set the target image GID}"
for value in "$OLD_UID" "$OLD_GID" "$NEW_UID" "$NEW_GID"; do
  case "$value" in ''|*[!0-9]*) echo 'UIDs and GIDs must be numeric' >&2; exit 1 ;; esac
done
# Do not follow links, cross filesystems, or re-own unrelated users' files.
# Refuse hardlinked regular files before making any changes: another path may
# sit outside this volume. The operator must inspect those separately.
if [ -n "$(find -P "$HOME_ROOT" -xdev -type f -uid "$OLD_UID" -gid "$OLD_GID" -links +1 -print -quit)" ]; then
  echo 'Home contains hardlinked state; inspect before migration' >&2
  exit 1
fi
find -P "$HOME_ROOT" -xdev -uid "$OLD_UID" -gid "$OLD_GID" \
  -exec chown -h --from="$OLD_UID:$OLD_GID" "$NEW_UID:$NEW_GID" {} +
