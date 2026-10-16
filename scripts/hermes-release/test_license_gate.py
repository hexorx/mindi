"""Synthetic OCI fixtures exercise fail-closed publication, never a registry."""
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import license_gate
import publish

SHA = 'a' * 40
DOCS = {path: b'synthetic test attribution, not release evidence\n'
        for path in license_gate.REQUIRED}


def tar_bytes(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as archive:
        for name, value in (entries.items() if isinstance(entries, dict) else entries):
            member = tarfile.TarInfo(name)
            if isinstance(value, tuple):
                member.type, member.linkname = value
                archive.addfile(member)
            else:
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
    return out.getvalue()


def image(path, layers, source=SHA, corrupt=False):
    files = {}
    def add(data):
        digest = hashlib.sha256(data).hexdigest()
        files['blobs/sha256/' + digest] = data
        return {'digest': 'sha256:' + digest, 'size': len(data)}
    config = add(json.dumps({'config': {'Labels': {
        'org.opencontainers.image.revision': source}}}).encode())
    descriptors = [add(tar_bytes(layer)) for layer in layers]
    raw = json.dumps({'schemaVersion': 2, 'config': config, 'layers': descriptors}).encode()
    manifest = add(raw)
    files['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [manifest]}).encode()
    if corrupt:
        files['blobs/sha256/' + descriptors[0]['digest'].split(':')[1]] = b'corrupt'
    path.write_bytes(tar_bytes(files))
    return raw


class LicenseGateTests(unittest.TestCase):
    def test_missing_empty_whitespace_and_links_fail_before_any_push(self):
        for required in DOCS:
            for value in (None, b'', b' \n\t', (tarfile.SYMTYPE, '/elsewhere'),
                          (tarfile.LNKTYPE, next(iter(DOCS)))):
                with self.subTest(path=required, value=value), tempfile.TemporaryDirectory() as tmp:
                    files = dict(DOCS)
                    if value is None:
                        del files[required]
                    else:
                        files[required] = value
                    archive = Path(tmp) / 'image.tar'
                    image(archive, [files])
                    with patch.object(publish, 'run') as run, patch.object(publish, 'preflight') as preflight:
                        with self.assertRaises(ValueError):
                            publish.publish(SHA, archive, Path(tmp) / 'receipt.json')
                        run.assert_not_called()
                        preflight.assert_not_called()
                    self.assertFalse((Path(tmp) / 'receipt.json').exists())

    def test_valid_candidate_publishes_only_matching_manifest_and_records_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'image.tar'
            raw = image(archive, [DOCS])
            with patch.object(publish, 'preflight', return_value='sha-' + SHA), \
                 patch.object(publish, 'public_manifest', return_value=raw), \
                 patch.dict(os.environ, {'REGISTRY_AUTH_FILE': '/synthetic/auth'}), \
                 patch.object(publish, 'run', side_effect=[
                     subprocess.CompletedProcess([], 0, raw),
                     subprocess.CompletedProcess([], 0, b''),
                     subprocess.CompletedProcess([], 0, raw)]) as run:
                publish.publish(SHA, archive, root / 'receipt.json')
            self.assertEqual(run.call_args_list[1].args[0][:2], ['skopeo', 'copy'])
            evidence = json.loads((root / 'license-summary.json').read_text())
            self.assertEqual(evidence['manifest_digest'], 'sha256:' + hashlib.sha256(raw).hexdigest())
            self.assertEqual(evidence['workflow_sha'], SHA)
            self.assertEqual(evidence['built_source_sha'], SHA)
            self.assertEqual(len(evidence['documents']), 2)

    def test_whiteout_opaque_directory_and_later_empty_replacement_refuse(self):
        required = license_gate.REQUIRED[0]
        parent = str(Path(required).parent)
        for later in ({parent + '/.wh.LICENSE': b''},
                      {parent + '/.wh..wh..opq': b''},
                      {required: b''}, {'usr/share/.wh.doc': b''},
                      {parent: (tarfile.SYMTYPE, '/elsewhere')}):
            with self.subTest(later=later), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / 'image.tar'
                image(archive, [DOCS, later])
                with self.assertRaises(ValueError):
                    license_gate.check(archive, SHA)

    def test_non_regular_replacements_fail_before_any_push(self):
        for required in DOCS:
            for kind in (tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE,
                         tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE):
                replacement = (required, (kind, '/elsewhere'))
                for same_layer in (False, True):
                    with self.subTest(path=required, kind=kind, same_layer=same_layer), \
                         tempfile.TemporaryDirectory() as tmp:
                        layers = ([list(DOCS.items()) + [replacement]] if same_layer
                                  else [DOCS, [replacement]])
                        archive = Path(tmp) / 'image.tar'
                        image(archive, layers)
                        with patch.object(publish, 'run') as run, \
                             patch.object(publish, 'preflight') as preflight:
                            with self.assertRaisesRegex(ValueError, 'non-regular'):
                                publish.publish(SHA, archive, Path(tmp) / 'receipt.json')
                            run.assert_not_called()
                            preflight.assert_not_called()
                        self.assertFalse((Path(tmp) / 'receipt.json').exists())

    def test_final_regular_replacement_supplies_current_bytes(self):
        for required in DOCS:
            for same_layer in (False, True):
                with self.subTest(path=required, same_layer=same_layer), \
                     tempfile.TemporaryDirectory() as tmp:
                    replacement = [(required, (tarfile.DIRTYPE, ''))]
                    final = [(required, b'final replacement attribution\n')]
                    layers = ([list(DOCS.items()) + replacement + final] if same_layer
                              else [DOCS, replacement, final])
                    archive = Path(tmp) / 'image.tar'
                    image(archive, layers)
                    evidence = license_gate.check(archive, SHA)
                    documents = {item['path']: item for item in evidence['documents']}
                    for path, original in DOCS.items():
                        expected = final[0][1] if path == required else original
                        self.assertEqual(documents['/' + path]['size'], len(expected))
                        self.assertEqual(documents['/' + path]['sha256'],
                                         hashlib.sha256(expected).hexdigest())

    def test_whiteouts_do_not_remove_same_layer_additions(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'image.tar'
            layer = {**DOCS, 'usr/share/doc/agent-box-hermes/.wh..wh..opq': b''}
            image(archive, [DOCS, layer])
            self.assertEqual(license_gate.check(archive, SHA)['status'], 'passed')

    def test_wrong_source_corrupt_blob_and_unsafe_layer_paths_refuse(self):
        for source, corrupt, layers in [('b' * 40, False, [DOCS]),
                                        (SHA, True, [DOCS]),
                                        (SHA, False, [{**DOCS, '../outside': b'x'}])]:
            with self.subTest(source=source, corrupt=corrupt), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / 'image.tar'
                image(archive, layers, source=source, corrupt=corrupt)
                with self.assertRaises(ValueError):
                    license_gate.check(archive, SHA)

    def test_other_manifest_cannot_reuse_licensing_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'image.tar'
            image(archive, [DOCS])
            with patch.object(publish, 'preflight', return_value='sha-' + SHA), \
                 patch.object(publish, 'run', return_value=subprocess.CompletedProcess([], 0, b'other')) as run:
                with self.assertRaisesRegex(ValueError, 'differs'):
                    publish.publish(SHA, archive, Path(tmp) / 'receipt.json')
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0][:2], ['skopeo', 'inspect'])

    def test_packaged_notices_match_authentic_inputs_and_root_license(self):
        root = Path(__file__).resolve().parents[2]
        directory = root / 'apps/agent-box/backend/infra/backend-box/licenses'
        spec = importlib.util.spec_from_file_location('assemble_notices', directory / 'assemble.py')
        assembler = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assembler)
        self.assertEqual((directory / 'LICENSE').read_bytes(), (root / 'LICENSE').read_bytes())
        self.assertEqual((directory / 'THIRD-PARTY-NOTICES').read_bytes(), assembler.assemble(directory))
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / 'image.tar'
            image(archive, [{path: (directory / Path(path).name).read_bytes()
                             for path in license_gate.REQUIRED}])
            self.assertEqual(license_gate.check(archive, SHA)['status'], 'passed')

    def test_changed_or_empty_upstream_notice_cannot_be_assembled(self):
        root = Path(__file__).resolve().parents[2]
        directory = root / 'apps/agent-box/backend/infra/backend-box/licenses'
        spec = importlib.util.spec_from_file_location('assemble_notices', directory / 'assemble.py')
        assembler = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assembler)
        for value in (b'', b'changed attribution'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                copied = Path(tmp) / 'licenses'
                shutil.copytree(directory, copied)
                (copied / 'upstream/aml.txt').write_bytes(value)
                with self.assertRaises(ValueError):
                    assembler.assemble(copied)

    def test_workflow_mandatory_gates_precede_push(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/hermes-promote.yml').read_text()
        push = workflow.index('scripts/hermes-release/publish.py publish')
        for command in ('scripts/hermes-release/scan_layers.py',
                        'scripts/hermes-release/license_gate.py',
                        'apps/agent-box/test/smoke.py hermes-release:local'):
            position = workflow.index(command)
            self.assertLess(position, push)
            step = workflow[workflow.rfind('      - name:', 0, position):]
            step = step.split('\n      - ', 1)[0]
            self.assertNotIn('continue-on-error:', step)
            self.assertNotIn('if:', step)
        self.assertIn('${{ runner.temp }}/license-summary.json', workflow)


if __name__ == '__main__':
    unittest.main()
