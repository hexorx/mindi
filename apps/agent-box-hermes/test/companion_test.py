"""Companion transport/identity negatives; fake bytes and network only."""
import copy
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts/hermes-release'))
import companion
import gate
import promote
from companion_fixtures import make_companion, sha
from promotion_test import Candidate


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.c = Candidate(self.root)
        self.record = self.c.record
        self.directory = self.root / 'source-companion'
        self.config = self.c.manifest['config']['digest']

    def verify(self):
        return companion.verify(self.record, self.directory, self.config)

    def reseal(self, n, raw):
        asset = self.record['source_companion']['assets'][n]
        (self.directory / asset['name']).write_bytes(raw)
        asset.update(size=len(raw), sha256=sha(raw))

    def test_valid(self):
        self.assertEqual(self.verify()['assets'], 5)

    def test_license_reconciliation_required_fields(self):
        changes = [lambda m, f: m.pop('license_reconciliation'),
                   lambda m, f: m.update(license_reconciliation=None)]
        for key in ('image_index', 'file', 'sha256'):
            changes.append(lambda m, f, key=key: m['license_reconciliation'].pop(key))
        for n, change in enumerate(changes):
            with self.subTest(case=n):
                make_companion(self.record, self.directory, self.config, mutate=change)
                with self.assertRaisesRegex(ValueError, 'license reconciliation'):
                    self.verify()

    def test_license_reconciliation_binds_final_index(self):
        for digest in ('sha256:' + '0' * 64, self.record['platform_manifest_digest'], self.config):
            with self.subTest(digest=digest):
                make_companion(self.record, self.directory, self.config,
                               mutate=lambda m, f: m['license_reconciliation'].update(image_index=digest))
                with self.assertRaisesRegex(ValueError, 'license reconciliation image index mismatch'):
                    self.verify()

    def test_readme_license_reconciliation_matches_manifest(self):
        for case in ('file', 'sha256', 'missing', 'duplicate'):
            with self.subTest(case=case):
                def change(manifest, files):
                    if case in ('file', 'sha256'):
                        manifest['license_reconciliation'][case] = 'other.tsv' if case == 'file' else '0' * 64
                    else:
                        lines = files['README.md'].splitlines(keepends=True)
                        line = next(x for x in lines if x.startswith(b'- License reconciliation'))
                        files['README.md'] = (b''.join(x for x in lines if x != line) if case == 'missing'
                                              else files['README.md'] + line)
                make_companion(self.record, self.directory, self.config, mutate=change)
                with self.assertRaisesRegex(ValueError, 'README license reconciliation mismatch'):
                    self.verify()

    def test_required_sidecar_inventory(self):
        original = copy.deepcopy(self.record)
        for n in (2, 3):
            for case in ('absent', 'duplicate', 'extra', 'wrong-id', 'oversized'):
                with self.subTest(sidecar=n, case=case):
                    self.record = copy.deepcopy(original)
                    assets = self.record['source_companion']['assets']
                    if case == 'absent':
                        assets.pop(n)
                    elif case == 'duplicate':
                        assets.insert(n, copy.deepcopy(assets[n]))
                    elif case == 'extra':
                        assets.append(dict(assets[n], id=999, name='unexpected.json'))
                    elif case == 'wrong-id':
                        assets[n]['id'] = assets[0]['id']
                    else:
                        assets[n]['size'] = companion.META_LIMIT + 1
                    with self.assertRaises(ValueError):
                        companion.inventory(self.record)

    def test_sidecar_bytes_missing_tampered_and_archive_mismatched(self):
        for n in (2, 3):
            for case in ('missing', 'tampered', 'truncated', 'archive-mismatched'):
                with self.subTest(sidecar=n, case=case):
                    make_companion(self.record, self.directory, self.config)
                    asset = self.record['source_companion']['assets'][n]
                    path = self.directory / asset['name']
                    raw = path.read_bytes()
                    if case == 'missing':
                        hidden = path.with_suffix('.missing')
                        path.rename(hidden)
                        with self.assertRaisesRegex(ValueError, 'missing/extra'):
                            self.verify()
                        hidden.rename(path)
                    elif case == 'archive-mismatched':
                        # Both documents remain valid and identity-equivalent, but
                        # independently pinned bytes must equal the archive bytes.
                        self.reseal(n, raw + b'\n')
                        with self.assertRaisesRegex(ValueError, 'external/internal.*sidecar mismatch'):
                            self.verify()
                    else:
                        path.write_bytes(raw[:-1] if case == 'truncated' else b'!' + raw[1:])
                        with self.assertRaisesRegex(ValueError, 'asset size/hash mismatch'):
                            self.verify()

    def test_missing_tampered_and_partial_asset(self):
        asset = self.record['source_companion']['assets'][4]
        path = self.directory / asset['name']
        original = path.read_bytes()
        for raw in [original[:-1], original + b'x', b'x' + original[1:]]:
            path.write_bytes(raw)
            with self.assertRaises(ValueError): self.verify()
        path.rename(path.with_suffix('.missing'))
        with self.assertRaises(ValueError): self.verify()

    def test_inventory_refuses_missing_duplicate_wrong_repo_url_ids_names(self):
        original = copy.deepcopy(self.record)
        changes = [lambda r: r.pop('source_companion'),
                   lambda r: r['source_companion'].update(repository='attacker/mindi'),
                   lambda r: r['source_companion'].update(release_id=True),
                   lambda r: r['source_companion'].update(url='https://example.com'),
                   lambda r: r['source_companion']['assets'][4].update(id=42),
                   lambda r: r['source_companion']['assets'][4].update(id='102'),
                   lambda r: r['source_companion']['assets'][4].update(name='../part'),
                   lambda r: r['source_companion']['assets'].reverse(),
                   lambda r: r['source_companion']['assets'][4].update(size=companion.PART_LIMIT + 1)]
        for change in changes:
            self.record = copy.deepcopy(original)
            change(self.record)
            with self.assertRaises((ValueError, KeyError)): self.verify()

    def test_cross_subject_and_incomplete_source(self):
        changes = []
        for key in ('index', 'manifest', 'config', 'built_source'):
            changes.append(lambda m, f, key=key: m['image'].update({key: 'wrong'}))
        changes += [lambda m, f: m.update(delivered=False), lambda m, f: m.update(mode='resolve-only'),
                    lambda m, f: m.update(unsourced=[{'name': 'missing'}]),
                    lambda m, f: m['inventory'].update(identity_errors=['bad']),
                    lambda m, f: m['sources'][0]['files'][0].update(size=8),
                    lambda m, f: m['sources'][0]['files'][0].update(sha256='0'*64),
                    lambda m, f: m['sources'].append(copy.deepcopy(m['sources'][0])),
                    lambda m, f: f.update({'unexpected.txt': b'extra'}),
                    lambda m, f: f.update({'README.md': f['README.md'].replace(b'Built source:', b'Wrong source:')}),
                    lambda m, f: f.update({'README.md': f['README.md'] + b'Built source: `wrong`\n'}),
                    lambda m, f: f.pop('sources/example/source.txt')]
        for change in changes:
            make_companion(self.record, self.directory, self.config, mutate=change)
            with self.assertRaises(ValueError): self.verify()

    def test_malformed_parts_and_outer_checksums(self):
        original = (self.directory / self.record['source_companion']['assets'][0]['name']).read_bytes()
        for change in [lambda d: d.update(tar_sha256='0'*64), lambda d: d.update(manifest_sha256='0'*64),
                       lambda d: d.update(members_sha256sums_sha256='0'*64),
                       lambda d: d['parts'][0].update(size=1), lambda d: d.update(part_limit=1),
                       lambda d: d.update(tar_size=1), lambda d: d.update(extra=True)]:
            data = json.loads(original)
            change(data)
            self.reseal(0, json.dumps(data).encode())
            with self.assertRaises(ValueError): self.verify()
        self.reseal(0, original[:-1] + b',"schema":"duplicate"}')
        with self.assertRaises(ValueError): self.verify()
        self.reseal(0, original)
        sums = (self.directory / self.record['source_companion']['assets'][1]['name']).read_bytes()
        self.reseal(1, sums + sums)
        with self.assertRaises(ValueError): self.verify()

    def test_special_duplicate_and_traversal_members(self):
        for name, kind in [('escape', tarfile.SYMTYPE), ('../escape', tarfile.REGTYPE), ('manifest.json', tarfile.REGTYPE)]:
            member = tarfile.TarInfo(companion.prefix(self.record) + '/' + name)
            member.type = kind
            member.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
            make_companion(self.record, self.directory, self.config, extra=member)
            with self.assertRaises(ValueError): self.verify()

    def test_wrong_label_refused(self):
        other = self.root / 'wrong-label'
        other.mkdir()
        c = Candidate(other, companion_url='https://github.com/hexorx/mindi/releases/tag/wrong')
        with patch.object(promote, 'registry_token') as token:
            with self.assertRaisesRegex(ValueError, 'label mismatch'):
                promote.publish(c.record, other, other)
            token.assert_not_called()

    def release(self, draft=False):
        return {'id': 99, 'tag_name': 'hermes-source-' + self.record['source_commit'],
                'html_url': companion.pointer(self.record), 'draft': draft, 'published_at': '2026-10-01T00:00:00Z'}

    def listed(self):
        return [dict(a, state='uploaded') for a in self.record['assets'] + self.record['source_companion']['assets']]

    def test_release_membership_visibility_and_pointer(self):
        for anonymous in (False, True):
            with patch.object(promote, 'public_github' if anonymous else 'github', side_effect=[self.release(), self.release(), self.listed()] if anonymous else [self.release(True), self.listed()]):
                promote.release_assets(self.record, anonymous)
        for release in [self.release(True), dict(self.release(), id=98), dict(self.release(), html_url='https://example.com'), dict(self.release(), tag_name='wrong')]:
            with patch.object(promote, 'public_github', return_value=release):
                with self.assertRaises(ValueError): promote.release_assets(self.record, True)
        for listed in [self.listed()[:-1], self.listed() + [self.listed()[0]], [dict(a, size=1) for a in self.listed()]]:
            with patch.object(promote, 'github', side_effect=[self.release(), listed]):
                with self.assertRaises(ValueError): promote.release_assets(self.record)

    def test_anonymous_failure_prevents_credentials_and_every_copy(self):
        with patch.object(promote, 'download_companion', side_effect=ValueError('source unavailable')), patch.object(promote, 'registry_token') as token, patch.object(promote, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'source unavailable'): promote.publish(self.record, self.root, self.root)
            token.assert_not_called()
            run.assert_not_called()

    def test_archive_mismatched_sidecars_prevent_publication(self):
        for n in (2, 3):
            make_companion(self.record, self.directory, self.config)
            asset = self.record['source_companion']['assets'][n]
            self.reseal(n, (self.directory / asset['name']).read_bytes() + b'\n')
            with patch.object(promote, 'registry_token') as token, patch.object(promote, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'external/internal.*sidecar mismatch'):
                    promote.publish(self.record, self.root, self.root)
                token.assert_not_called()
                run.assert_not_called()

    def test_download_bounds_partial_hash_and_anonymous_credentials(self):
        class Response(io.BytesIO):
            status = 200
            headers = {}
        asset = {'id': 123, 'size': 4, 'sha256': sha(b'data')}
        for n, data in enumerate([b'data', b'dat', b'dataX', b'evil']):
            with patch.object(urllib.request, 'build_opener') as opener, patch.dict('os.environ', {'GH_TOKEN': 'secret-fixture'}):
                opener.return_value.open.return_value = Response(data)
                if data == b'data': promote.fetch_asset(asset, self.root / str(n), anonymous=True)
                else:
                    with self.assertRaises(ValueError): promote.fetch_asset(asset, self.root / str(n), anonymous=True)
                request = opener.return_value.open.call_args.args[0]
                self.assertNotIn('Authorization', request.headers)
                self.assertEqual(request.full_url, 'https://api.github.com/repos/hexorx/mindi/releases/assets/123')

    def test_separate_download_and_anonymous_verification(self):
        class Response(io.BytesIO):
            status = 200
            headers = {}
        blobs = {a['id']: (self.directory / a['name']).read_bytes() for a in self.record['source_companion']['assets']}
        def open_asset(request, **kwargs):
            self.assertNotIn('Authorization', request.headers)
            return Response(blobs[int(request.full_url.rsplit('/', 1)[1])])
        with patch.object(promote, 'public_github', side_effect=[self.release(), self.release(), self.listed()]), patch.object(urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = open_asset
            downloaded = promote.download_companion(self.record, self.root, anonymous=True)
        self.assertEqual(companion.verify(self.record, downloaded, self.config)['assets'], 5)
        self.assertFalse((self.root / 'candidate.zip').exists())

    def test_ordered_multiple_parts(self):
        assets = self.record['source_companion']['assets']
        tar = (self.directory / assets[4]['name']).read_bytes()
        limit = len(tar) // 2
        parts = []
        for n, raw in enumerate((tar[:limit], tar[limit:])):
            name = companion.prefix(self.record) + '.tar.part%02d' % n
            (self.directory / name).write_bytes(raw)
            parts.append({'name': name, 'size': len(raw), 'sha256': sha(raw)})
        info = json.loads((self.directory / assets[0]['name']).read_bytes())
        info.update(parts=parts, part_limit=limit)
        self.reseal(0, json.dumps(info).encode())
        self.reseal(1, ''.join(p['sha256'] + '  ' + p['name'] + '\n' for p in parts).encode())
        assets[4:] = [dict(p, id=104 + n) for n, p in enumerate(parts)]
        with patch.object(companion, 'PART_LIMIT', limit):
            self.assertEqual(self.verify()['assets'], 6)
            assets[4:] = list(reversed(assets[4:]))
            with self.assertRaises(ValueError): self.verify()

    def test_redirect_strips_auth_and_refuses_untrusted_host(self):
        request = urllib.request.Request('https://api.github.com/x', headers={'Authorization': 'fixture'})
        handler = promote.AssetRedirect()
        redirected = handler.redirect_request(request, None, 302, '', {}, 'https://release-assets.githubusercontent.com/x')
        self.assertNotIn('Authorization', redirected.headers)
        for url in ['http://release-assets.githubusercontent.com/x', 'https://evil.example/x', 'https://api.github.com/elsewhere']:
            with self.assertRaises(ValueError): handler.redirect_request(request, None, 302, '', {}, url)
