#!/usr/bin/env bash
# Offline, consistent archive. Restore only into a newly created empty volume.
set -euo pipefail
umask 077
operation=${1:?backup or restore}
container=${2:?Stopped source container}
archive=${3:?Archive filename}
[ "$(docker inspect -f '{{.State.Status}}' "$container")" = exited ] || { echo 'memory: stop the source container before backup/restore' >&2; exit 1; }
[ "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0 ] || { echo 'memory: source must have shut down cleanly' >&2; exit 1; }
image=$(docker inspect -f '{{.Image}}' "$container")
case "$operation" in
    backup)
        # noclobber preserves an existing backup and catches operator typos.
        set -o noclobber
        docker run --rm --network none --volumes-from "$container":ro --entrypoint tar "$image" \
            -C /var/lib/agent-box/hindsight -czf - . > "$archive"
        chmod 600 "$archive"
        ;;
    restore)
        volume=${4:?New empty destination volume}
        docker volume inspect "$volume" >/dev/null
        docker run --rm -i --network none --mount "type=volume,src=$volume,dst=/restore" \
            --entrypoint python3 "$image" -c '
import os, pathlib, sys, tarfile
root = pathlib.Path("/restore")
if any(root.iterdir()): raise SystemExit("memory: restore requires an empty destination")
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|gz") as archive:
    archive.extractall(root, filter="data")
for path in [root, *root.rglob("*")]:
    os.chown(path, 1000, 1000, follow_symlinks=False)
' < "$archive"
        ;;
    *) echo 'memory: expected backup or restore' >&2; exit 1 ;;
esac
