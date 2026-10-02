"""Successor lock: exact scope, authenticated indexes, closure and runtime tooling."""
import hashlib
import json
import lzma
from pathlib import Path
import re
import unittest
from remediation_lock_test import rows, stanzas

ROOT = Path(__file__).resolve().parents[3]
BUILD = ROOT / 'apps/agent-box-hermes/build'
EVIDENCE = ROOT / 'docs/third-party/hex366-security-inputs'
TARGETS = {
    'bsdutils': '1:2.41.5-0+deb13u1',
    'login': '1:4.16.0-2+really2.41.5-0+deb13u1',
    **dict.fromkeys(['libblkid1', 'liblastlog2-2', 'libmount1', 'libsmartcols1',
                     'libuuid1', 'mount', 'util-linux'], '2.41.5-0+deb13u1'),
    'libpng16-16t64': '1.6.48-1+deb13u6',
    'libsrt1.5-gnutls': '1.5.4-1+deb13u1',
    'librabbitmq4': '0.15.0-1+deb13u2',
    'libasound2t64': '1.2.14-1+deb13u1',
    'libasound2-data': '1.2.14-1+deb13u1',
    'sed': '4.9-2+deb13u1',
}


class FixNowLockTest(unittest.TestCase):
    def test_exact_inventory_and_lock_delta(self):
        old = rows(EVIDENCE / 'baseline-apt-final-inventory.tsv')
        new = rows(BUILD / 'apt-final-inventory.tsv')
        self.assertEqual(set(old), set(new))
        self.assertEqual({n for n in old if old[n] != new[n]}, set(TARGETS))
        locked = rows(BUILD / 'apt-packages.lock')
        baseline = rows(EVIDENCE / 'baseline-apt-packages.lock')
        for name, row in baseline.items():
            self.assertEqual(row, locked[name], name)
        self.assertEqual(set(locked) - set(baseline), set(TARGETS))
        requested = (BUILD / 'apt-requested.list').read_text().split()
        for name, version in TARGETS.items():
            self.assertEqual(new[name][1], version)
            self.assertEqual(locked[name][1], version)
            self.assertIn(name, requested)

    def test_signed_index_chain_and_all_downloads(self):
        locked = rows(BUILD / 'apt-packages.lock')
        records = json.loads((EVIDENCE / 'binary-records.json').read_text())
        sources = json.loads((EVIDENCE / 'source-records.json').read_text())
        verification = json.loads((EVIDENCE / 'artifact-verification.json').read_text())
        self.assertEqual(len(verification), 34)
        self.assertTrue(all(r['verified'] for r in verification))
        for prefix, archive in [('', 'debian-security'), ('debian-', 'debian')]:
            release = (EVIDENCE / (prefix + 'InRelease')).read_text()
            for file, rel in [('Packages.xz', 'main/binary-amd64/Packages.xz'),
                              ('Sources.xz', 'main/source/Sources.xz')]:
                raw = (EVIDENCE / (prefix + file)).read_bytes()
                digest = hashlib.sha256(raw).hexdigest()
                self.assertRegex(release, rf'(?m)^ {digest} +{len(raw)} {re.escape(rel)}$')
            packages = stanzas(lzma.open(EVIDENCE / (prefix + 'Packages.xz'), 'rt').read())
            source_index = stanzas(lzma.open(EVIDENCE / (prefix + 'Sources.xz'), 'rt').read())
            for r in records:
                if r['archive'] != archive:
                    continue
                actual, = [p for p in packages if p.get('Package') == r['Package'] and p.get('Version') == r['Version']]
                self.assertEqual(locked[r['Package']][7:], [actual['SHA256'], actual['Size']])
                self.assertEqual(locked[r['Package']][6], r['url'])
                self.assertEqual(r['url'], f"https://snapshot.debian.org/archive/{archive}/20261002T120000Z/" + actual['Filename'])
            for r in sources:
                if '/archive/' + archive + '/' not in r['url']:
                    continue
                actual, = [p for p in source_index if p.get('Package') == r['source'] and p.get('Version') == r['version']]
                self.assertIn(f"{r['sha256']} {r['size']} {r['file']}", actual['Checksums-Sha256'])
        result = json.loads((EVIDENCE / 'resolver.json').read_text())
        self.assertEqual(result['exit'], 0)
        self.assertTrue(result['baseline_inventory_matches'])
        self.assertIn('15 upgraded, 0 newly installed, 0 to remove', result['stdout'])

    def test_node_fixed_versions_and_companions(self):
        packages = json.loads((BUILD / 'hermes-node-security.json').read_text())['packages']
        installed = {t['path']: p for p in packages for t in p['targets']}
        expected = {'colord': '2.9.4', 'baseline-browser-mapping': '2.11.0',
                    'vitest': '4.1.11', 'sanitize-html': '2.17.7', 'brace-expansion': '5.0.12'}
        expected.update({'@vitest/' + n: '4.1.11' for n in
                         ['mocker', 'spy', 'utils', 'expect', 'runner', 'snapshot', 'pretty-format']})
        artifacts = json.loads((EVIDENCE / 'node-artifact-verification.json').read_text())
        for name, version in expected.items():
            entry = installed['/opt/hermes/node_modules/' + name]
            self.assertEqual(entry['version'], version)
            artifact, = [a for a in artifacts if a['name'] == name]
            self.assertEqual(entry['sha256'], artifact['sha256'])
            self.assertTrue(artifact['verified'])
        self.assertTrue(all(r['passed'] for r in json.loads((EVIDENCE / 'node-closure.json').read_text())))

    def test_global_npm_fixed_versions_and_build_smoke(self):
        packages = json.loads((BUILD / 'hermes-node-security.json').read_text())['packages']
        artifacts = json.loads((EVIDENCE / 'npm-overlay-verification.json').read_text())
        for artifact in artifacts:
            entry, = [p for p in packages if p['name'] == artifact['name']
                       and p['targets'][0]['path'].startswith('/usr/local/')]
            self.assertEqual(entry['version'], artifact['version'])
            self.assertEqual(entry['sha256'], artifact['sha256'])
            self.assertEqual(entry['url'], artifact['url'])
            self.assertTrue(artifact['verified'])
        self.assertIn('RUN --network=none node /opt/build/verify_npm_security.mjs',
                      (BUILD.parent / 'Dockerfile').read_text())
        mapping = json.loads((EVIDENCE / 'row-mapping.json').read_text())
        f3 = [r for r in mapping if r['class'] == 'F3']
        self.assertEqual(len(f3), 5)
        self.assertTrue(all('source prepared' in r['status'] for r in f3))

    def test_hindsight_pip_is_build_only(self):
        dockerfile = (BUILD.parent / 'Dockerfile').read_text()
        self.assertLess(dockerfile.index('/opt/hindsight/bin/pip check'),
                        dockerfile.index('/opt/hindsight/bin/pip uninstall --yes pip'))
        self.assertIn("importlib.util.find_spec('pip') is None", dockerfile)
        self.assertNotIn('/opt/hindsight/bin/pip', dockerfile.split('FROM scratch AS runtime')[1])

    def test_current_input_hashes_and_unchanged_release_gate(self):
        manifest = json.loads((EVIDENCE / 'manifest.json').read_text())
        for filename, digest in {**manifest['changed_inputs'], **manifest['unchanged_inputs']}.items():
            self.assertEqual(hashlib.sha256((ROOT / filename).read_bytes()).hexdigest(), digest, filename)
