#!/usr/bin/env python3
"""Regenerate the apt snapshot lock from LAN build evidence.

Inputs are the HEX-184 evidence files (dpkg inventories of the pinned Hermes base
and of the built image, the build log's apt transaction and mirror artifact
hashes) plus the snapshot InRelease/Packages.xz files for the pinned timestamps.
Every changed package must resolve to exactly one snapshot artifact whose
filename, SHA256 and size equal the recorded mirror artifact; anything else fails.
"""
import argparse
import hashlib
import lzma
from pathlib import Path
import re
import sys

SNAPSHOT = 'https://snapshot.debian.org/archive'
DEBIAN = '20260929T202609Z'
SECURITY = '20260929T215738Z'
SUITES = {
    'trixie': ('debian', DEBIAN),
    'trixie-updates': ('debian', DEBIAN),
    'trixie-security': ('debian-security', SECURITY),
}
REQUESTED = ('sway grim wtype wl-clipboard foot xwayland dbus at-spi2-core '
             'fonts-dejavu-core fonts-noto-color-emoji wayvnc novnc websockify '
             'nginx openssl python3-yaml').split()
GET = re.compile(r'^#\d+ [\d.]+ Get:\d+ https?://deb\.debian\.org/(debian|debian-security) '
                 r'(trixie(?:-security|-updates)?)/main amd64 (\S+) (amd64|all) (\S+) \[')


def dpkg_rows(path):
    rows = {}
    for line in Path(path).read_text().splitlines():
        fields = line.split('\t')
        if len(fields) == 6 and fields[5] == 'installed':
            rows[fields[0]] = fields
    return rows


def plain(name):
    return name.split(':')[0]


def parse_packages(path):
    index = {}
    for stanza in lzma.open(path).read().decode().split('\n\n'):
        fields = {}
        for line in stanza.splitlines():
            if line and not line[0].isspace() and ':' in line:
                key, value = line.split(':', 1)
                fields[key] = value.strip()
        if 'Package' in fields:
            index.setdefault((fields['Package'], fields['Version']), []).append(fields)
    return index


def release_listed(inrelease, packages_xz):
    digest = hashlib.sha256(packages_xz.read_bytes()).hexdigest()
    return re.search(rf'^ {digest} +\d+ main/binary-amd64/Packages\.xz$',
                     inrelease.read_text(), re.M) is not None


def list_name(archive, stamp, suite):
    return f'snapshot.debian.org_archive_{archive}_{stamp}_dists_{suite}_InRelease'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path,
                        help='hex184-evidence-352b6eb directory')
    parser.add_argument('--snapshot', required=True, type=Path,
                        help='directory with <suite>.InRelease and <suite>.Packages.xz')
    parser.add_argument('--out', default=Path(__file__).resolve().parent, type=Path)
    args = parser.parse_args()
    run = args.evidence / 'run'
    base = dpkg_rows(run / 'apt/dpkg-base-hermes.tsv')
    final = dpkg_rows(run / 'apt/dpkg-installed.tsv')

    release_lines = []
    indices = {}
    for suite, (archive, stamp) in SUITES.items():
        inrelease = args.snapshot / f'{suite}.InRelease'
        packages = args.snapshot / f'{suite}.Packages.xz'
        if not release_listed(inrelease, packages):
            sys.exit(f'{suite}: Packages.xz is not listed in InRelease')
        digest = hashlib.sha256(inrelease.read_bytes()).hexdigest()
        release_lines.append(f'{digest}  {list_name(archive, stamp, suite)}')
        indices[suite] = parse_packages(packages)

    mirror = {}
    for line in (run / 'apt/apt-artifacts.txt').read_text().splitlines():
        fields = line.split('\t')
        if len(fields) == 6:
            mirror[(plain(fields[0]), fields[1])] = fields
    downloads = {}
    for line in (run / 'build/build.log').read_text().splitlines():
        match = GET.match(line)
        if match:
            _archive, suite, name, arch, version = match.groups()
            downloads[name] = (suite, arch, version)

    added = sorted(set(final) - set(base))
    upgraded = sorted(n for n in set(final) & set(base) if final[n][1] != base[n][1])
    if set(base) - set(final):
        sys.exit(f'packages removed from base: {sorted(set(base) - set(final))}')
    changed = {plain(n): n for n in added + upgraded}
    if set(changed) != set(downloads):
        sys.exit(f'download set differs from dpkg delta: {sorted(set(changed) ^ set(downloads))}')

    lock = ['# package\tversion\tarchitecture\tchange\tbase_version\tsuite\turl\tsha256\tsize']
    for name in sorted(changed):
        full = changed[name]
        suite, arch, version = downloads[name]
        if (version, arch) != (final[full][1], final[full][2]):
            sys.exit(f'{name}: downloaded {version} {arch} but installed {final[full][1:3]}')
        stanzas = [s for s in indices[suite].get((name, version), [])
                   if s['Architecture'] == arch]
        recorded = mirror.get((name, version))
        if len(stanzas) != 1 or recorded is None:
            sys.exit(f'{name} {version}: expected one snapshot stanza and one mirror artifact')
        stanza = stanzas[0]
        if (stanza['Filename'], stanza['SHA256'], stanza['Size']) != tuple(recorded[2:5]):
            sys.exit(f'{name} {version}: snapshot artifact differs from built artifact')
        archive, stamp = SUITES[suite]
        change = 'upgraded' if full in base else 'added'
        base_version = base[full][1] if full in base else '-'
        lock.append('\t'.join([name, version, arch, change, base_version, suite,
                               f'{SNAPSHOT}/{archive}/{stamp}/{stanza["Filename"]}',
                               stanza['SHA256'], stanza['Size']]))

    superseded = {}
    lookups = args.evidence / 'supplemental/debian-snapshot-lookups-for-superseded-packages.tsv'
    for line in lookups.read_text().splitlines()[1:]:
        f = line.split('\t')
        superseded[(plain(f[0]), f[1])] = f
    inherited = ['# package\tversion\tarchitecture\tsource\tsource_version\tbytes\tartifact_ref']
    for full in sorted(base):
        name, version, arch, source, source_version, _ = base[full]
        if full in upgraded:
            bytes_owner = f'replaced-by-lock:{final[full][1]}'
        else:
            bytes_owner = 'base-digest'
        if (plain(full), version) in mirror:
            f = mirror[(plain(full), version)]
            ref = f'deb.debian.org:{f[2]} sha256:{f[3]} size:{f[4]}'
        elif (plain(full), version) in superseded:
            f = superseded[(plain(full), version)]
            ref = f'snapshot:{f[6]}{f[7]}/{f[3]} sha1:{f[4]} size:{f[5]} first_seen:{f[8]}'
        elif full in upgraded:
            ref = '-'
        else:
            sys.exit(f'{full} {version}: no artifact reference')
        inherited.append('\t'.join([full, version, arch, source, source_version,
                                    bytes_owner, ref]))

    inventory = ['# package\tversion\tarchitecture']
    inventory += ['\t'.join(final[n][:3]) for n in sorted(final)]

    out = args.out
    (out / 'apt-release.sha256').write_text('\n'.join(release_lines) + '\n')
    (out / 'apt-packages.lock').write_text('\n'.join(lock) + '\n')
    (out / 'apt-inherited.tsv').write_text('\n'.join(inherited) + '\n')
    (out / 'apt-final-inventory.tsv').write_text('\n'.join(inventory) + '\n')
    (out / 'apt-requested.list').write_text('\n'.join(REQUESTED) + '\n')
    print(f'{len(added)} added, {len(upgraded)} upgraded, {len(base)} inherited, '
          f'{len(final)} final')


if __name__ == '__main__':
    main()
