"""Coverage must reject omissions, stale dispositions, and changed upstream bytes."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
NOTICES = ROOT / 'docs/third-party/hex263-uv-inputs'
spec = importlib.util.spec_from_file_location('uv_notices', ROOT / 'apps/agent-box-hermes/build/verify_uv_notices.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class UvNoticesTest(unittest.TestCase):
    def setUp(self):
        self.deps = {f'{name}.dep-v0.json': (NOTICES / f'{name}.dep-v0.json').read_bytes() for name in ('uv', 'uvx')}

    def test_full_approved_closure_and_byte_exact_notices(self):
        self.assertEqual(verify.verify(NOTICES, self.deps), 495)

    def test_unknown_crate_or_new_version_in_either_binary_fails(self):
        for binary in self.deps:
            for source in ('crates.io', 'git', 'local'):
                with self.subTest(binary=binary, source=source):
                    deps = copy.copy(self.deps)
                    data = json.loads(deps[binary])
                    data['packages'].append({'name': 'uncovered', 'version': '1.0.0', 'source': source})
                    deps[binary] = json.dumps(data).encode()
                    with self.assertRaisesRegex(ValueError, 'missing notice entry'):
                        verify.verify(NOTICES, deps)

    def test_altered_closure_fails_even_with_existing_notices(self):
        deps = copy.copy(self.deps)
        data = json.loads(deps['uvx.dep-v0.json'])
        data['packages'].pop()
        deps['uvx.dep-v0.json'] = json.dumps(data).encode()
        with self.assertRaisesRegex(ValueError, 'closure changed'):
            verify.verify(NOTICES, deps)

    def test_corrupt_file_missing_notice_and_stale_disposition_fail(self):
        original = Path.read_bytes
        for mode, error in [('upstream', 'upstream notice changed'), ('notice', 'shipped notice entry'),
                            ('version', 'exact-version disposition'), ('checksum', 'exact-version disposition'),
                            ('license', 'must use MPL-2.0')]:
            def read(path):
                data = original(path)
                if mode == 'upstream' and path.name == 'LICENSE-0BSD':
                    return data + b'changed'
                if mode == 'notice' and path.name == 'THIRD-PARTY-NOTICES-uv.txt':
                    return b''
                if path.name == 'dispositions.json':
                    doc = json.loads(data)
                    r = next(r for r in doc['records'] if r['name'] == 'priority-queue')
                    if mode == 'version':
                        r['version'] = '2.7.1'
                    if mode == 'checksum':
                        r['crate_sha256'] = '0' * 64
                    if mode == 'license':
                        r['distribution_license'] = 'LGPL-3.0-or-later'
                    return json.dumps(doc).encode()
                return data
            with self.subTest(mode=mode), patch.object(Path, 'read_bytes', read):
                with self.assertRaisesRegex(ValueError, error):
                    verify.verify(NOTICES, self.deps)

    def test_json_whitespace_is_not_a_closure_change(self):
        deps = {k: json.dumps(json.loads(v)).encode() for k, v in self.deps.items()}
        self.assertEqual(verify.verify(NOTICES, deps), 495)

    def test_non_elf_rejected(self):
        with self.assertRaisesRegex(ValueError, 'expected ELF64'):
            verify.dep_section(NOTICES / 'manifest.json')
