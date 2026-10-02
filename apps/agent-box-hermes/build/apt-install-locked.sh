#!/bin/bash
# Install the locked Debian closure on the pinned Hermes base, then purge the
# extraction-stripped packages. Refuses base drift, unlisted or re-versioned
# packages in the apt plan, artifacts whose SHA256/size differ from the lock,
# and any final dpkg inventory other than apt-final-inventory.tsv.
#
# Usage: apt-install-locked.sh [PACKAGE...]   (defaults to apt-requested.list)
set -euo pipefail

lock_dir=${APT_LOCK_DIR:-$(dirname "$(readlink -f "$0")")}
root=${APT_LOCK_ROOT:-}
lists=$root/var/lib/apt/lists
archives=$root/var/cache/apt/archives
purge=(sudo openssh-server)

die() { echo "apt-install-locked: $*" >&2; exit 1; }
rows() { grep -v '^#' "$1" | grep -v '^$' || true; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/sources"
cp "$lock_dir/apt-snapshot.sources" "$work/sources/snapshot.sources"
opts=(-o "Dir::Etc::SourceList=/dev/null" -o "Dir::Etc::SourceParts=$work/sources"
      -o "Acquire::Languages=none" -o "APT::Install-Recommends=false"
      -o "APT::Install-Suggests=false")

inventory() {
    dpkg-query -W -f '${db:Status-Status}\t${binary:Package}\t${Version}\t${Architecture}\n' \
        | awk -F'\t' -v bad="$work/bad-status" '
            $1 == "installed" { print $2 "\t" $3 "\t" $4; next }
            $1 != "not-installed" { print > bad }' | sort
    if [ -s "$work/bad-status" ]; then
        die "packages in unexpected dpkg states: $(cut -f2 "$work/bad-status" | tr '\n' ' ')"
    fi
}

[ "$(dpkg --print-architecture)" = amd64 ] || die "only amd64 is locked"

# apt resolves alternatives (e.g. libseat1's "seatd | logind") in request order,
# so the order in apt-requested.list is part of the lock.
rows "$lock_dir/apt-requested.list" > "$work/requested"
if [ "$#" -gt 0 ]; then
    printf '%s\n' "$@" > "$work/args"
    diff -u "$work/requested" "$work/args" >&2 \
        || die "requested packages or their order differ from apt-requested.list; regenerate the lock"
fi
mapfile -t requested < "$work/requested"

# Pin the entire expected final inventory. A newer security snapshot must not
# broaden this transaction or change inherited packages implicitly.
rows "$lock_dir/apt-final-inventory.tsv" | awk -F'\t' '
    { sub(/:.*/, "", $1); printf "Package: %s\nPin: version %s\nPin-Priority: 1001\n\n", $1, $2 }
    END { print "Package: *\nPin: version *\nPin-Priority: -1" }' > "$work/preferences"
opts+=(-o "Dir::Etc::Preferences=$work/preferences" -o "Dir::Etc::PreferencesParts=-")

rows "$lock_dir/apt-inherited.tsv" | cut -f1-3 | sort > "$work/expected-base"
inventory > "$work/base"
diff -u "$work/expected-base" "$work/base" >&2 \
    || die "base image inventory differs from apt-inherited.tsv"

rm -rf "$lists"/* "$archives"/*.deb "$archives"/partial/*
apt-get "${opts[@]}" update
find "$lists" -maxdepth 1 -type f \( -name '*Release' -o -name '*InRelease' \) -printf '%f\n' \
    | sort > "$work/release-files"
cut -d' ' -f3 "$lock_dir/apt-release.sha256" | sort | diff -u - "$work/release-files" >&2 \
    || die "apt fetched release files other than apt-release.sha256"
(cd "$lists" && sha256sum --quiet --strict -c "$lock_dir/apt-release.sha256") \
    || die "snapshot InRelease bytes differ from apt-release.sha256"

rows "$lock_dir/apt-packages.lock" | awk -F'\t' '{print $1 "\t" $2 "\t" $3 "\t" $5}' \
    | sort > "$work/expected-plan"
apt-get "${opts[@]}" -s install "${requested[@]}" > "$work/simulation"
if grep -Eq '^(Remv|Purg) ' "$work/simulation"; then
    die "apt plan removes packages: $(grep -E '^(Remv|Purg) ' "$work/simulation" | tr '\n' ' ')"
fi
sed -nE 's/^Inst ([^ :]+)(:[^ ]+)? (\[([^]]+)\] )?\(([^ ]+) .*\[([^]]+)\]\)( \[[^]]*\])?$/\1\t\5\t\6\t\4/p' \
    "$work/simulation" | awk -F'\t' '{if ($4 == "") $4 = "-"; print $1 "\t" $2 "\t" $3 "\t" $4}' OFS='\t' \
    | sort > "$work/plan"
[ "$(grep -c '^Inst ' "$work/simulation" || true)" = "$(wc -l < "$work/plan")" ] \
    || die "could not parse every Inst line of the apt plan"
diff -u "$work/expected-plan" "$work/plan" >&2 \
    || die "apt plan differs from apt-packages.lock (unlisted package or version drift)"

mkdir -p "$archives/partial"
while IFS=$'\t' read -r name version arch _change _base _suite url sha256 size; do
    case "$url" in https://snapshot.debian.org/archive/*) ;; *) die "$name: non-snapshot URL";; esac
    file="${name}_${version//:/%3a}_${arch}.deb"
    curl -fsSL --proto '=https' --retry 3 -o "$archives/partial/$file" "$url"
    [ "$(stat -c %s "$archives/partial/$file")" = "$size" ] || die "$name: size differs from lock"
    echo "$sha256  $archives/partial/$file" | sha256sum --quiet --strict -c - \
        || die "$name: SHA256 differs from lock"
    mv "$archives/partial/$file" "$archives/$file"
done < <(rows "$lock_dir/apt-packages.lock")

apt-get "${opts[@]}" install -y --no-download "${requested[@]}"
apt-get "${opts[@]}" purge -y --no-download "${purge[@]}"

rows "$lock_dir/apt-final-inventory.tsv" | sort > "$work/expected-final"
inventory > "$work/final"
diff -u "$work/expected-final" "$work/final" >&2 \
    || die "final inventory differs from apt-final-inventory.tsv"
for name in "${purge[@]}"; do
    ! grep -q "^$name	" "$work/final" || die "$name is still installed"
done
rm -rf "$lists"/* "$archives"/*.deb "$archives"/partial/*
echo "apt-install-locked: $(wc -l < "$work/expected-plan") locked packages installed; inventory verified"
