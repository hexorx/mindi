"""Checks for the immutable Debian snapshot lock and its enforcing installer."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1]
BUILD = APP / 'build'
HELPER = BUILD / 'apt-install-locked.sh'
STAMPS = {'debian': '20260930T082601Z', 'debian-security': '20260930T060347Z'}


def rows(path):
    return [line.split('\t') for line in path.read_text().splitlines()
            if line and not line.startswith('#')]


class LockFilesTest(unittest.TestCase):
    def setUp(self):
        self.lock = rows(BUILD / 'apt-packages.lock')
        self.inherited = rows(BUILD / 'apt-inherited.tsv')
        self.final = rows(BUILD / 'apt-final-inventory.tsv')

    def test_closure_counts_match_the_resolved_build(self):
        changes = [row[3] for row in self.lock]
        self.assertEqual(changes.count('added'), 121)
        self.assertEqual(changes.count('upgraded'), 39)
        self.assertEqual(len(self.inherited), 432)
        self.assertEqual(len(self.final), 553)

    def test_every_artifact_is_a_pinned_snapshot_url_with_hash(self):
        for name, version, arch, change, base, suite, url, sha256, size in self.lock:
            archive = 'debian-security' if suite == 'trixie-security' else 'debian'
            stamp = '20261001T172817Z' if name in {'chromium', 'chromium-common', 'libexpat1', 'libexpat1-dev'} else STAMPS[archive]
            prefix = f'https://snapshot.debian.org/archive/{archive}/{stamp}/pool/'
            self.assertTrue(url.startswith(prefix), url)
            self.assertTrue(url.endswith(f'_{arch}.deb'), url)
            self.assertRegex(sha256, r'^[0-9a-f]{64}$')
            self.assertRegex(size, r'^[1-9][0-9]*$')
            self.assertEqual(base == '-', change == 'added', name)

    def test_final_inventory_is_base_plus_lock(self):
        base = {r[0].split(':')[0]: r for r in self.inherited}
        expected = {r[0].split(':')[0]: (r[1], r[2]) for r in self.inherited}
        for name, version, arch, change, base_version, *_ in self.lock:
            if change == 'upgraded':
                self.assertEqual(base[name][1], base_version, name)
                self.assertEqual(base[name][5], f'replaced-by-lock:{version}', name)
            else:
                self.assertNotIn(name, base)
            expected[name] = (version, arch)
        final = {r[0].split(':')[0]: (r[1], r[2]) for r in self.final}
        self.assertEqual(final, expected)

    def test_inherited_rows_keep_source_and_byte_owner(self):
        for row in self.inherited:
            self.assertEqual(len(row), 7, row)
            self.assertTrue(row[3] and row[4], row)
            self.assertRegex(row[5], r'^(base-digest|replaced-by-lock:.+)$')
            if row[5] == 'base-digest':
                self.assertRegex(row[6], r'^(deb\.debian\.org:|snapshot:)')

    def test_sources_are_authenticated_snapshots_only(self):
        text = (BUILD / 'apt-snapshot.sources').read_text()
        uris = re.findall(r'^URIs: (.+)$', text, re.M)
        self.assertEqual(uris, [f'https://snapshot.debian.org/archive/{a}/{s}'
                                for a, s in STAMPS.items()] +
                         ['https://snapshot.debian.org/archive/debian-security/20261001T172817Z'])
        self.assertEqual(text.count('Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp'), 3)
        self.assertNotIn('deb.debian.org', text)
        self.assertNotIn('Trusted:', text)
        pins = [line.split('  ') for line in (BUILD / 'apt-release.sha256').read_text().splitlines()]
        self.assertEqual(len(pins), 4)
        for digest, name in pins:
            self.assertRegex(digest, r'^[0-9a-f]{64}$')
            archive = 'debian-security' if 'security' in name else 'debian'
            if '20261001T172817Z' in name:
                self.assertEqual(name, 'snapshot.debian.org_archive_debian-security_20261001T172817Z_dists_trixie-security_InRelease')
                continue
            self.assertTrue(name.startswith(
                f'snapshot.debian.org_archive_{archive}_{STAMPS[archive]}_dists_'), name)

    def test_requested_list_matches_extraction_package_set(self):
        self.assertEqual(
            (BUILD / 'apt-requested.list').read_text().split(),
            'sway grim wtype wl-clipboard foot xwayland dbus at-spi2-core fonts-dejavu-core '
            'fonts-noto-color-emoji wayvnc novnc websockify nginx openssl python3-yaml chromium '
            'docker-cli gzip libaom3 libc-bin libc-dev-bin libc6 libc6-dev libglib2.0-0t64 '
            'libmbedcrypto16 libpcre2-8-0 libperl5.40 libpython3.13 libpython3.13-dev '
            'libpython3.13-minimal libpython3.13-stdlib libsqlite3-0 libssh-4 libssh2-1t64 '
            'perl perl-base perl-modules-5.40 python3.13 python3.13-dev python3.13-minimal '
            'python3.13-venv xserver-common xvfb libexpat1 libexpat1-dev'.split())

    def test_chromium_artifacts_match_retained_build_evidence(self):
        import json
        evidence = APP.parents[1] / 'docs/third-party/hex198-build-inputs'
        manifest = json.loads((evidence / 'manifest.json').read_text())
        for name, digest in manifest['files'].items():
            self.assertEqual(hashlib.sha256((evidence / name).read_bytes()).hexdigest(), digest)
        additions = rows(evidence / 'chromium-new-lock-rows.tsv')
        self.assertEqual(len(additions), 20)
        for row in additions:
            if row[0] in {'chromium', 'chromium-common'}:
                continue  # Replaced by signed HEX-345 inputs; historical bytes remain intact.
            # Historical evidence keeps its old snapshot URL; artifact bytes stay pinned.
            current = next(r for r in self.lock if r[0] == row[0])
            self.assertEqual(current[:6] + current[7:], row[:6] + row[7:])
        self.assertIn('chromium', {r[0] for r in self.final})
        self.assertIn('ffmpeg', {r[0] for r in self.final})

    def test_helper_preserves_extraction_purge(self):
        self.assertIn('purge=(sudo openssh-server)', HELPER.read_text())


STUBS = {
    'dpkg': 'echo amd64\n',
    'dpkg-query': 'cat "$STUB/installed.tsv"\n',
    'apt-get': r'''
echo "apt-get $*" >> "$STUB/log"
for option in "$@"; do
  case "$option" in Dir::Etc::Preferences=*) cp "${option#*=}" "$STUB/preferences" ;; esac
done
case " $* " in
  *" update "*) cp "$STUB"/lists/* "$APT_LOCK_ROOT/var/lib/apt/lists/" ;;
  *" -s "*) cat "$STUB/simulation" ;;
  *" install "*) cp "$STUB/after-install.tsv" "$STUB/installed.tsv" ;;
  *" purge "*) grep -v -e '	sudo	' -e '	openssh-server	' "$STUB/installed.tsv" > "$STUB/t"
               mv "$STUB/t" "$STUB/installed.tsv" ;;
esac
''',
    'curl': r'''
while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; -*) shift;; *) url=$1; shift;; esac; done
echo "curl $url" >> "$STUB/log"
cp "$STUB/debs/${url##*/}" "$out"
''',
}


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.stub = self.tmp / 'stub'
        self.locks = self.tmp / 'lock'
        self.root = self.tmp / 'root'
        bindir = self.tmp / 'bin'
        for path in [self.stub / 'lists', self.stub / 'debs', self.locks, bindir,
                     self.root / 'var/lib/apt/lists', self.root / 'var/cache/apt/archives']:
            path.mkdir(parents=True)
        for name, body in STUBS.items():
            (bindir / name).write_text('#!/bin/bash\n' + body)
            (bindir / name).chmod(0o755)
        self.env = dict(os.environ, PATH=f'{bindir}:{os.environ["PATH"]}',
                        STUB=str(self.stub), APT_LOCK_DIR=str(self.locks),
                        APT_LOCK_ROOT=str(self.root))
        # Shell startup hooks can replace PATH and bypass the isolated stubs.
        self.env.pop('BASH_ENV', None)

        release = 'snapshot.debian.org_archive_debian_20260930T082601Z_dists_trixie_InRelease'
        (self.stub / 'lists' / release).write_bytes(b'signed release\n')
        digest = hashlib.sha256(b'signed release\n').hexdigest()
        (self.locks / 'apt-release.sha256').write_text(f'{digest}  {release}\n')
        shutil.copy(BUILD / 'apt-snapshot.sources', self.locks)
        (self.locks / 'apt-requested.list').write_text('newpkg\n')
        (self.locks / 'apt-inherited.tsv').write_text(
            '# header\nbase-files\t13\tamd64\tbase-files\t13\tbase-digest\tx\n'
            'libfoo:amd64\t1.0\tamd64\tfoo\t1.0\treplaced-by-lock:1.1\tx\n')
        self.debs = {'newpkg_3.0_all.deb': b'new', 'libfoo_1.1_amd64.deb': b'foo'}
        lock = ['# header']
        for (name, version, arch, change, base), deb in zip(
                [('libfoo', '1.1', 'amd64', 'upgraded', '1.0'),
                 ('newpkg', '3.0', 'all', 'added', '-')], sorted(self.debs)):
            data = self.debs[deb]
            (self.stub / 'debs' / deb).write_bytes(data)
            lock.append('\t'.join([name, version, arch, change, base, 'trixie',
                                   f'https://snapshot.debian.org/archive/debian/x/pool/{deb}',
                                   hashlib.sha256(data).hexdigest(), str(len(data))]))
        (self.locks / 'apt-packages.lock').write_text('\n'.join(lock) + '\n')
        (self.locks / 'apt-final-inventory.tsv').write_text(
            '# header\nbase-files\t13\tamd64\nlibfoo:amd64\t1.1\tamd64\nnewpkg\t3.0\tall\n')
        (self.stub / 'installed.tsv').write_text(
            'installed\tbase-files\t13\tamd64\ninstalled\tlibfoo:amd64\t1.0\tamd64\n')
        (self.stub / 'after-install.tsv').write_text(
            'installed\tbase-files\t13\tamd64\ninstalled\tlibfoo:amd64\t1.1\tamd64\n'
            'installed\tnewpkg\t3.0\tall\n')
        self.simulate(
            'Inst libfoo [1.0] (1.1 Debian:13.4/stable [amd64])\n'
            'Inst newpkg (3.0 Debian:13.4/stable [all])\n'
            'Conf libfoo (1.1 Debian:13.4/stable [amd64])\n')

    def simulate(self, text):
        (self.stub / 'simulation').write_text(text)

    def run_helper(self, *args):
        result = subprocess.run(['bash', str(HELPER), *args], env=self.env,
                                capture_output=True, text=True)
        log = (self.stub / 'log').read_text() if (self.stub / 'log').exists() else ''
        return result, log

    def assert_refused(self, message, *args):
        result, log = self.run_helper(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertNotRegex(log, r'apt-get .* install -y')
        return log

    def test_installs_locked_closure_and_purges(self):
        result, log = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('2 locked packages installed', result.stdout)
        self.assertIn('install -y --no-download newpkg', log)
        self.assertIn('purge -y --no-download sudo openssh-server', log)
        self.assertIn('Dir::Etc::SourceList=/dev/null', log)
        self.assertEqual(log.count('curl '), 2)
        self.assertEqual(list((self.root / 'var/cache/apt/archives').glob('*.deb')), [])

    def test_resolver_pins_exact_inventory_and_excludes_other_versions(self):
        result, log = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        preferences = (self.stub / 'preferences').read_text()
        self.assertIn('Package: libfoo\nPin: version 1.1\nPin-Priority: 1001', preferences)
        self.assertIn('Package: base-files\nPin: version 13\nPin-Priority: 1001', preferences)
        self.assertIn('Package: *\nPin: version *\nPin-Priority: -1', preferences)
        self.assertIn('Dir::Etc::PreferencesParts=-', log)

    def test_refuses_version_drift_before_download(self):
        self.simulate('Inst libfoo [1.0] (1.1 x [amd64])\nInst newpkg (3.1 x [all])\n')
        log = self.assert_refused('version drift')
        self.assertNotIn('curl ', log)

    def test_refuses_unlisted_package(self):
        self.simulate('Inst libfoo [1.0] (1.1 x [amd64])\nInst newpkg (3.0 x [all])\n'
                      'Inst extra (1 x [all])\n')
        self.assert_refused('unlisted package')

    def test_refuses_upgrade_from_unexpected_base_version(self):
        self.simulate('Inst libfoo [0.9] (1.1 x [amd64])\nInst newpkg (3.0 x [all])\n')
        self.assert_refused('apt plan differs')

    def test_refuses_removals(self):
        self.simulate('Inst newpkg (3.0 x [all])\nRemv libfoo [1.0]\n')
        self.assert_refused('removes packages')

    def test_refuses_artifact_hash_mismatch(self):
        (self.stub / 'debs/newpkg_3.0_all.deb').write_bytes(b'NEW')
        self.assert_refused('SHA256 differs')

    def test_refuses_base_drift(self):
        with (self.stub / 'installed.tsv').open('a') as f:
            f.write('installed\tsudo\t1\tamd64\n')
        log = self.assert_refused('base image inventory differs')
        self.assertNotIn('update', log)

    def test_refuses_different_release_bytes(self):
        for path in (self.stub / 'lists').iterdir():
            path.write_text('other release\n')
        self.assert_refused('InRelease bytes differ')

    def test_refuses_changed_request_without_relock(self):
        self.assert_refused('regenerate the lock', 'newpkg', 'otherpkg')

    def test_keeps_locked_request_order(self):
        (self.locks / 'apt-requested.list').write_text('newpkg\nlibfoo\n')
        self.assert_refused('order differ', 'libfoo', 'newpkg')
        _, log = self.run_helper('newpkg', 'libfoo')
        self.assertIn('install -y --no-download newpkg libfoo', log)

    def test_refuses_final_inventory_drift(self):
        with (self.stub / 'after-install.tsv').open('a') as f:
            f.write('installed\tsurprise\t1\tall\n')
        result, _ = self.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('final inventory differs', result.stderr)


if __name__ == '__main__':
    unittest.main()
