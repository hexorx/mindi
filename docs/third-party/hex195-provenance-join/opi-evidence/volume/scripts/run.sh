#!/bin/sh
# HEX-192 read-only evidence run against the final image. No push, no deploy of the image, no deletes of existing data.
set -u
IMG=sha256:3819c0400a46d16ed3307ac3caa419a669ac91b1c9490998335773d76e35731f
VOL=hex192-evidence
O=/out
mkdir -p $O/run $O/facts $O/bin $O/scripts $O/go
cp /hex192/* $O/scripts/; chmod 444 $O/scripts/*
status() { echo "$(date -u +%FT%TZ) $*" | tee -a $O/run/status.log; }
status "start"
apk add --no-cache coreutils >/dev/null 2>&1 || true
df -h /out > $O/run/df-start.txt 2>&1
docker image inspect "$IMG" --format '{{.Id}} {{json .RepoTags}} {{json .RepoDigests}} {{.Os}}/{{.Architecture}} layers={{len .RootFS.Layers}}' > $O/run/image-identity.txt 2>&1 || { status "FAIL image missing"; exit 1; }
docker image inspect "$IMG" --format '{{json .RootFS.Layers}}' > $O/run/image-layers.json 2>&1

docker run --rm --network none --read-only --tmpfs /tmp:rw,size=2g -v $VOL:/w --entrypoint /usr/bin/python3 "$IMG" \
  /w/scripts/probe.py /w/facts > $O/facts/probe.log 2>&1
echo "rc=$?" >> $O/facts/probe.log
status "probe $(tail -1 $O/facts/probe.log)"

CID=$(docker create "$IMG" /bin/true)
docker cp "$CID:/usr/bin/docker" $O/bin/docker 2>>$O/run/bins.err
docker rm -v "$CID" >/dev/null
(cd $O/bin && sha256sum * > ../facts/extracted-bins.sha256)

docker run --rm --network none -v $VOL:/w --entrypoint go golang:1.25-bookworm version -m /w/bin/docker > $O/go/docker-buildinfo.txt 2>&1
echo "rc=$?" >> $O/go/docker-buildinfo.txt
docker image inspect golang:1.25-bookworm --format '{{.Id}} {{json .RepoDigests}}' >> $O/go/docker-buildinfo.txt 2>&1
status "go buildinfo done"

docker run --rm -v $VOL:/w --entrypoint sh debian:trixie-slim /w/scripts/debfetch.sh > $O/run/debfetch.log 2>&1
echo "rc=$?" >> $O/run/debfetch.log
docker image inspect debian:trixie-slim --format '{{.Id}} {{json .RepoDigests}}' >> $O/run/debfetch.log 2>&1
status "debfetch done"

(cd $O && find . -type f ! -path './run/status.log' ! -name 'SHA256SUMS*' ! -path './deb/*.deb' -exec sha256sum {} + | sort -k2 > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
status "DONE lines=$(wc -l < $O/SHA256SUMS)"
touch $O/run/ALL.DONE
