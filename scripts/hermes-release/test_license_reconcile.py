import hashlib
from unittest import mock
import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import license_reconcile as lr  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "tailscale-5f0521ca-sbom-subset.json")
TS = ("go-module", "tailscale.com", "UNKNOWN")
WEB = ("go-module", "github.com/tailscale/web-client-prebuilt", "v0.0.0-20250124233751-d4cd19a26976")


def load():
    with open(FIXTURE) as f:
        return json.load(f)


def arts(sbom, key, path=None):
    return [a for a in sbom["artifacts"] if (a["type"], a["name"], a["version"]) == key
            and (path is None or a["locations"][0]["path"] == path)]


class BoundClassification(unittest.TestCase):
    def setUp(self):
        # Synthetic bytes exercise the verifier; production pins are never CLI inputs.
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.evidence = {}
        hashes = {}
        for name in lr.TS_EVIDENCE:
            path = os.path.join(self.tmp.name, name)
            data = (name + " reviewed fixture bytes\n").encode()
            with open(path, "wb") as f:
                f.write(data)
            self.evidence[name] = path
            hashes[name] = hashlib.sha256(data).hexdigest()
        patch = mock.patch.dict(lr.TS_EVIDENCE, hashes, clear=True)
        patch.start()
        self.addCleanup(patch.stop)

    def run_reconcile(self, sbom, cache=None, pins=None):
        return {(r["name"], r["location"]): r
                for r in lr.reconcile(sbom, cache or {}, pins or {}, self.evidence)}

    def test_verified_build_gets_bound_licenses(self):
        rows = self.run_reconcile(load())
        for path in lr.TS_BINARIES:
            self.assertEqual(rows[("tailscale.com", path)]["license"], "BSD-3-Clause AND Apache-2.0 AND 0BSD")
            self.assertEqual(rows[(WEB[1], path)]["license"], "")
            self.assertEqual(rows[(WEB[1], path)]["disposition"], "UNRESOLVED")
            self.assertEqual(rows[("tailscale.com", path)]["class"], "permissive")

    def assertFailsClosed(self, sbom, needle):
        with self.assertRaises(lr.BindingError) as cm:
            self.run_reconcile(sbom)
        self.assertIn(needle, str(cm.exception))

    def test_review_negative_control(self):
        sbom = load()
        sbom["source"]["metadata"]["manifestDigest"] = "sha256:" + "0" * 64
        for a in arts(sbom, TS):
            a["locations"][0]["path"] = "/opt/unrelated/tailscaled"
            a["metadata"].pop("goBuildSettings")
        with self.assertRaises(lr.BindingError) as cm:
            self.run_reconcile(sbom)
        msg = str(cm.exception)
        self.assertEqual(len(msg.splitlines()), 4)
        for needle in ("manifestDigest", "'/opt/unrelated/tailscaled' is not a verified binary", "goBuildSettings", WEB[1]):
            self.assertIn(needle, msg)

    def test_manifest_digest_mismatch(self):
        sbom = load()
        sbom["source"]["metadata"]["manifestDigest"] = "sha256:" + "0" * 64
        self.assertFailsClosed(sbom, "source.metadata.manifestDigest")

    def test_config_digest_mismatch(self):
        sbom = load()
        sbom["source"]["metadata"].pop("imageID")
        self.assertFailsClosed(sbom, "source.metadata.imageID")

    def test_unrelated_path(self):
        sbom = load()
        arts(sbom, TS, "/usr/local/bin/tailscaled")[0]["locations"][0]["path"] = "/opt/unrelated/tailscaled"
        self.assertFailsClosed(sbom, "is not a verified binary")

    def test_removed_build_metadata(self):
        sbom = load()
        arts(sbom, TS, "/usr/local/bin/tailscale")[0]["metadata"].pop("goBuildSettings")
        self.assertFailsClosed(sbom, "goBuildSettings")

    def test_changed_build_setting(self):
        sbom = load()
        for s in arts(sbom, TS, "/usr/local/bin/tailscale")[0]["metadata"]["goBuildSettings"]:
            if s["key"] == "CGO_ENABLED":
                s["value"] = "1"
        self.assertFailsClosed(sbom, "goBuildSettings")

    def test_go_version_mismatch(self):
        sbom = load()
        arts(sbom, TS, "/usr/local/bin/tailscale")[0]["metadata"]["goCompiledVersion"] = "go1.26.7"
        self.assertFailsClosed(sbom, "goCompiledVersion")

    def test_binary_hash_mismatch(self):
        sbom = load()
        sbom["files"][0]["digests"][0]["value"] = "0" * 64
        self.assertFailsClosed(sbom, "file sha256")

    def test_missing_file_digests(self):
        sbom = load()
        sbom.pop("files")
        self.assertFailsClosed(sbom, "file sha256=None")

    def test_layer_mismatch(self):
        sbom = load()
        arts(sbom, TS, "/usr/local/bin/tailscale")[0]["locations"][0]["layerID"] = "sha256:" + "1" * 64
        self.assertFailsClosed(sbom, "layerID")

    def test_dependency_h1_changed(self):
        sbom = load()
        for a in sbom["artifacts"]:
            if a["name"] == "golang.org/x/crypto" and a["locations"][0]["path"] == "/usr/local/bin/tailscaled":
                a["version"], a["metadata"]["h1Digest"] = "v0.54.0", "h1:Cs/rJgzyrqWn4qIAwc9l4/lPKAQY2/9zj9GtgCf1qjs="
        self.assertFailsClosed(sbom, "go deps digest")

    def test_extra_dependency(self):
        sbom = load()
        extra = copy.deepcopy(arts(sbom, WEB, "/usr/local/bin/tailscale")[0])
        extra["name"] = "example.com/unexpected"
        sbom["artifacts"].append(extra)
        self.assertFailsClosed(sbom, "go deps digest")

    def test_web_client_h1_mismatch(self):
        sbom = load()
        arts(sbom, WEB, "/usr/local/bin/tailscale")[0]["metadata"]["h1Digest"] = "h1:AAAA"
        self.assertFailsClosed(sbom, "h1Digest")

    def test_cli_exits_nonzero_on_mismatch(self):
        sbom = load()
        sbom["source"]["metadata"]["manifestDigest"] = "sha256:" + "0" * 64
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for name, obj in (("syft.json", sbom), ("cache.json", {}), ("pins.json", {}), ("evidence.json", self.evidence)):
                paths.append(os.path.join(d, name))
                with open(paths[-1], "w") as f:
                    json.dump(obj, f)
            self.assertEqual(lr.main([*paths[:3], d, paths[3]]), 2)
            self.assertFalse(os.path.exists(os.path.join(d, "reconciliation.tsv")))

    def test_each_evidence_input_missing_or_changed(self):
        for name, path in list(self.evidence.items()):
            with self.subTest(name=name, mutation="missing path"):
                self.evidence[name] = path + ".missing"
                self.assertFailsClosed(load(), name)
            self.evidence[name] = path
            with open(path, "rb") as f:
                original = f.read()
            with self.subTest(name=name, mutation="changed bytes"):
                with open(path, "ab") as f:
                    f.write(b"unlinked lock entry or altered retained bytes\n")
                self.assertFailsClosed(load(), name)
            with open(path, "wb") as f:
                f.write(original)
            with self.subTest(name=name, mutation="omitted input"):
                self.evidence.pop(name)
                self.assertFailsClosed(load(), "evidence must name exactly")
            self.evidence[name] = path

    def test_no_evidence_cannot_classify(self):
        with self.assertRaises(lr.BindingError):
            lr.reconcile(load(), {}, {})

    def test_web_cannot_be_resolved_by_cache_pins_or_detected_license(self):
        sbom = load()
        for a in arts(sbom, WEB):
            a["licenses"] = [{"value": "MIT"}]
        rows = self.run_reconcile(sbom, {"|".join(WEB): {"depsdev": {"licenses": ["MIT"]}}},
                                  {"components": [{"type": WEB[0], "name": WEB[1], "version": WEB[2], "sources": []}]})
        for path in lr.TS_BINARIES:
            self.assertEqual(rows[(WEB[1], path)]["disposition"], "UNRESOLVED")
            self.assertEqual(rows[(WEB[1], path)]["class"], "unclassified")

    def test_cli_evidence_failure_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for name, data in (("syft", load()), ("cache", {}), ("pins", {}), ("evidence", self.evidence)):
                path = os.path.join(d, name + ".json")
                with open(path, "w") as f:
                    json.dump(data, f)
                paths.append(path)
            outputs = [os.path.join(d, n) for n in ("reconciliation.tsv", "reconciliation-summary.json")]
            for path in outputs:
                with open(path, "w") as f:
                    f.write("previous output")
            for name, path in self.evidence.items():
                with self.subTest(name=name):
                    with open(path, "rb") as f:
                        original = f.read()
                    with open(path, "ab") as f:
                        f.write(b"mutation")
                    self.assertEqual(lr.main([*paths[:3], d, paths[3]]), 2)
                    for output in outputs:
                        with open(output) as f:
                            self.assertEqual(f.read(), "previous output")
                    with open(path, "wb") as f:
                        f.write(original)

    def test_cli_requires_evidence_argument(self):
        self.assertEqual(lr.main(["sbom", "cache", "pins", "out"]), 2)

    def test_bound_keys_are_not_also_manual(self):
        self.assertFalse(set(lr.BOUND) & set(lr.MANUAL))


if __name__ == "__main__":
    unittest.main()
