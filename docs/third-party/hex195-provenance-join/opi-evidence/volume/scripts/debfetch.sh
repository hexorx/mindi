#!/bin/sh
# HEX-192: fetch Debian docker-cli 26.1.5+dfsg1-9+b13 through apt's signed chain (fallback: snapshot by sha1)
# and compare its usr/bin/docker with the file extracted from the final image. Writes only under /w/deb.
set -u
O=/w/deb
mkdir -p $O && cd $O
V=26.1.5+dfsg1-9+b13
SHA1=1d5ed5bf92d1baddbb4dbaa7df5c00542a79ef36
apt-get update -qq >/dev/null 2>&1
echo "== apt-cache policy"; apt-cache policy docker-cli
echo "== apt-cache show"; apt-cache show docker-cli=$V 2>&1 | grep -E '^(Package|Version|Source|Filename|Size|SHA256|MD5sum):' | tee apt-cache-show.txt
if apt-get download -q docker-cli=$V >apt-download.log 2>&1; then echo "fetched via apt signed chain" > fetch-method.txt
else
  echo "apt download failed; snapshot /file/$SHA1" > fetch-method.txt
  apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null 2>&1
  curl -sSfL -o docker-cli_${V}_amd64.deb https://snapshot.debian.org/file/$SHA1 >>apt-download.log 2>&1
fi
D=$(ls docker-cli_*_amd64.deb | head -1)
echo "== deb"; ls -l "$D"; sha256sum "$D" | tee deb.sha256; sha1sum "$D" | tee deb.sha1
[ "$(sha1sum "$D" | cut -d' ' -f1)" = "$SHA1" ] && echo "deb sha1 matches lock sha1 $SHA1" || echo "deb sha1 DIFFERS from lock sha1 $SHA1"
dpkg-deb -f "$D" > deb-control.txt
mkdir -p x ctl && dpkg-deb -x "$D" x && dpkg-deb -e "$D" ctl
grep ' usr/bin/docker$' ctl/md5sums | tee deb-md5sums-docker.txt
sha256sum x/usr/bin/docker | tee deb-usr-bin-docker.sha256
md5sum x/usr/bin/docker | tee deb-usr-bin-docker.md5
I=$(sha256sum /w/bin/docker | cut -d' ' -f1); E=$(sha256sum x/usr/bin/docker | cut -d' ' -f1)
echo "image_sha256=$I deb_sha256=$E identical=$([ "$I" = "$E" ] && echo yes || echo NO)" | tee compare.txt
cmp /w/bin/docker x/usr/bin/docker && echo "cmp: byte-identical" | tee -a compare.txt
rm -rf x InRelease gpgv.txt inrelease-head.txt packages-check.txt packages-docker-cli.txt

apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils gpgv debian-archive-keyring >/dev/null 2>&1
for spec in 20260510T144321Z:trixie-proposed-updates 20260520T000000Z:trixie; do
  TS=${spec%%:*}; SU=${spec#*:}; T=signed-$TS-$SU; mkdir -p $T
  echo "== signed snapshot index check $TS $SU" | tee $T/check.txt
  S=https://snapshot.debian.org/archive/debian/$TS/dists/$SU
  curl -sSfL -o $T/InRelease $S/InRelease
  gpgv --keyring /usr/share/keyrings/debian-archive-keyring.gpg $T/InRelease > $T/gpgv.txt 2>&1; echo "gpgv rc=$?" | tee -a $T/gpgv.txt $T/check.txt
  grep -E '^(Origin|Suite|Codename|Date):' $T/InRelease | tee -a $T/check.txt
  PX=$(awk '/^SHA256:/{f=1;next} /^[A-Za-z]/{f=0} f && $3=="main/binary-amd64/Packages.xz"{print $1}' $T/InRelease)
  curl -sSfL -o $T/Packages.xz $S/main/binary-amd64/Packages.xz
  echo "Packages.xz expected=$PX actual=$(sha256sum $T/Packages.xz | cut -d' ' -f1)" | tee -a $T/check.txt
  xz -dc $T/Packages.xz | awk -v RS= '/^Package: docker-cli\n/' | grep -E '^(Package|Source|Version|Filename|Size|SHA256):' | tee $T/packages-docker-cli.txt | tee -a $T/check.txt
  grep -q "SHA256: $(cut -d' ' -f1 deb.sha256)" $T/packages-docker-cli.txt && echo "RESULT deb sha256 listed in signed index" | tee -a $T/check.txt || echo "RESULT deb sha256 NOT listed" | tee -a $T/check.txt
  rm -f $T/Packages.xz
done
