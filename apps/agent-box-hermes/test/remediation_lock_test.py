"""Four-package scope and authenticated artifact/provenance regression gates."""
import hashlib
import json
import lzma
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / 'apps/agent-box-hermes/build'
EVIDENCE = ROOT / 'docs/third-party/hex345-security-inputs'
TARGETS = {'chromium': '154.0.8037.92-1~deb13u1',
           'chromium-common': '154.0.8037.92-1~deb13u1',
           'libexpat1': '2.8.3-1~deb13u1', 'libexpat1-dev': '2.8.3-1~deb13u1'}


def rows(path):
    return {r[0].split(':')[0]: r for line in path.read_text().splitlines()
            if line and not line.startswith('#') for r in [line.split('\t')]}


def stanzas(text):
    records = []
    for paragraph in text.split('\n\n'):
        fields = {}
        key = None
        for line in paragraph.splitlines():
            if line.startswith(' ') and key:
                fields[key] += '\n' + line
            elif ': ' in line or line.endswith(':'):
                key, value = line.split(':', 1)
                fields[key] = value.strip()
        if fields:
            records.append(fields)
    return records


class RemediationLockTest(unittest.TestCase):
    def test_base_stages_and_non_debian_locks_remain_unchanged(self):
        manifest = json.loads((EVIDENCE / 'manifest.json').read_text())
        successor = json.loads((ROOT / 'docs/third-party/hex366-security-inputs/manifest.json').read_text())
        for filename, digest in manifest['unchanged_inputs'].items():
            if filename in successor['changed_inputs']:
                self.assertEqual(successor['base_inputs'][filename], digest, filename)
                continue
            self.assertEqual(hashlib.sha256((ROOT / filename).read_bytes()).hexdigest(), digest, filename)

    def test_exact_four_package_delta_and_unchanged_artifacts(self):
        old = rows(EVIDENCE / 'baseline-apt-final-inventory.tsv')
        new = rows(ROOT / 'docs/third-party/hex366-security-inputs/baseline-apt-final-inventory.tsv')
        self.assertEqual(set(old), set(new))
        self.assertEqual({n for n in old if old[n] != new[n]}, set(TARGETS))
        self.assertEqual(len(new), 553)
        baseline = rows(EVIDENCE / 'baseline-apt-packages.lock')
        locked = rows(ROOT / 'docs/third-party/hex366-security-inputs/baseline-apt-packages.lock')
        self.assertEqual(set(locked) - set(baseline), {'libexpat1', 'libexpat1-dev'})
        for name, row in baseline.items():
            if name not in TARGETS:
                self.assertEqual(row, locked[name], name)
        for name, version in TARGETS.items():
            self.assertEqual(new[name][1:], [version, 'amd64'])
            self.assertEqual(locked[name][1], version)

    def test_index_chain_and_binary_locks(self):
        manifest = json.loads((EVIDENCE / 'manifest.json').read_text())
        for filename, digest in manifest['files'].items():
            self.assertEqual(hashlib.sha256((EVIDENCE / filename).read_bytes()).hexdigest(), digest, filename)
        release = (EVIDENCE / 'InRelease').read_text()
        for filename, relative in [('Packages.xz', 'main/binary-amd64/Packages.xz'),
                                   ('Sources.xz', 'main/source/Sources.xz')]:
            data = (EVIDENCE / filename).read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            self.assertRegex(release, rf'(?m)^ {digest} +{len(data)} {re.escape(relative)}$')
        packages = stanzas(lzma.decompress((EVIDENCE / 'Packages.xz').read_bytes()).decode())
        locked = rows(BUILD / 'apt-packages.lock')
        for name, version in TARGETS.items():
            matches = [r for r in packages if r.get('Package') == name and r.get('Version') == version]
            self.assertEqual(len(matches), 1)
            record = matches[0]
            self.assertEqual(record['Architecture'], 'amd64')
            row = locked[name]
            self.assertEqual(row[6], 'https://snapshot.debian.org/archive/debian-security/20261001T172817Z/' + record['Filename'])
            self.assertEqual(row[7:], [record['SHA256'], record['Size']])
        release_hash = hashlib.sha256((EVIDENCE / 'InRelease').read_bytes()).hexdigest()
        self.assertIn(release_hash + '  snapshot.debian.org_archive_debian-security_20261001T172817Z_dists_trixie-security_InRelease',
                      (BUILD / 'apt-release.sha256').read_text())

    def test_sources_bound_to_authenticated_index(self):
        sources = stanzas(lzma.decompress((EVIDENCE / 'Sources.xz').read_bytes()).decode())
        records = json.loads((EVIDENCE / 'source-records.json').read_text())
        self.assertEqual(len(records), 7)
        for row in records:
            version = TARGETS['chromium' if row['source'] == 'chromium' else 'libexpat1']
            source = next(s for s in sources if s.get('Package') == row['source'] and s.get('Version') == version)
            self.assertIn(f"{row['sha256']} {row['size']} {row['file']}", source['Checksums-Sha256'])
            self.assertTrue(row['url'].endswith('/' + source['Directory'] + '/' + row['file']))
        for name in TARGETS:
            self.assertTrue((EVIDENCE / (name + '-copyright')).read_bytes())

    def test_all_seventeen_advisories_keep_their_membership_and_qualifications(self):
        groups = json.loads((EVIDENCE / 'advisories.json').read_text())['groups']
        self.assertEqual(len(groups), 17)
        members = [h for g in groups for h in g['native_hashes']]
        self.assertEqual(len(members), 34)
        self.assertEqual(len(set(members)), 34)
        self.assertTrue(all(g['range_pass'] and g['linux_qualification'] for g in groups))
        self.assertEqual(sum(g['source'] == 'chromium' for g in groups), 16)
        expat = next(g for g in groups if g['source'] == 'expat')
        self.assertIn('unresolved', expat['linux_qualification'])

    def test_resolver_reports_only_four_upgrades(self):
        result = json.loads((EVIDENCE / 'resolver.json').read_text())
        self.assertEqual(result['exit'], 0)
        self.assertTrue(result['baseline_inventory_matches'])
        self.assertIn('4 upgraded, 0 newly installed, 0 to remove', result['stdout'])
        self.assertEqual(set(re.findall(r'^Inst (\S+)', result['stdout'], re.M)), set(TARGETS))

    def test_source_ci_cannot_build_this_candidate_before_review(self):
        workflow = (ROOT / '.github/workflows/hermes-desktop.yml').read_text()
        self.assertIn("if: github.event_name != 'pull_request' || github.head_ref != 'codi/hex-342-chromium-expat-remediation'", workflow)
        self.assertIn('pnpm test', (ROOT / '.github/workflows/ci.yml').read_text())
