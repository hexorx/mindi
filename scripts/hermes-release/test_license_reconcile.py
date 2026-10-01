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


def run(sbom):
    return {(r["name"], r["location"]): r for r in lr.reconcile(sbom, {}, {})}


class BoundClassification(unittest.TestCase):
    def test_verified_build_gets_bound_licenses(self):
        rows = run(load())
        for path in lr.TS_BINARIES:
            self.assertEqual(rows[("tailscale.com", path)]["license"], "BSD-3-Clause AND Apache-2.0 AND 0BSD")
            self.assertEqual(rows[(WEB[1], path)]["license"], "BSD-3-Clause AND MIT AND OFL-1.1")
            self.assertEqual(rows[("tailscale.com", path)]["class"], "permissive")

    def assertFailsClosed(self, sbom, needle):
        with self.assertRaises(lr.BindingError) as cm:
            run(sbom)
        self.assertIn(needle, str(cm.exception))

    def test_review_negative_control(self):
        sbom = load()
        sbom["source"]["metadata"]["manifestDigest"] = "sha256:" + "0" * 64
        for a in arts(sbom, TS):
            a["locations"][0]["path"] = "/opt/unrelated/tailscaled"
            a["metadata"].pop("goBuildSettings")
        with self.assertRaises(lr.BindingError) as cm:
            run(sbom)
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
            for name, obj in (("syft.json", sbom), ("cache.json", {}), ("pins.json", {})):
                paths.append(os.path.join(d, name))
                with open(paths[-1], "w") as f:
                    json.dump(obj, f)
            self.assertEqual(lr.main([*paths, d]), 2)
            self.assertFalse(os.path.exists(os.path.join(d, "reconciliation.tsv")))

    def test_bound_keys_are_not_also_manual(self):
        self.assertFalse(set(lr.BOUND) & set(lr.MANUAL))


if __name__ == "__main__":
    unittest.main()
