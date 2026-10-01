#!/usr/bin/env python3
"""Per-artifact license reconciliation for non-Debian Syft artifacts with no
detected license. Inputs: Syft JSON, upstream-cache.json from classify.py,
pins.json. Writes reconciliation.tsv and reconciliation-summary.json.

Usage: license_reconcile.py SYFT_JSON UPSTREAM_CACHE PINS OUT_DIR EVIDENCE_JSON

Re-run against a replacement image's SBOM after classify.py refreshes the cache.
BOUND classifications apply only to the exact build they were verified on; any
mismatch exits non-zero instead of applying the license.
"""
import collections
import hashlib
import json
import re
import sys
from pathlib import Path

COPYLEFT = re.compile(r"\b(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CeCILL|GNU (Lesser )?General Public)", re.I)
PERMISSIVE = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unicode-3.0", "0BSD", "BSL-1.0",
              "CC0-1.0", "MIT-0", "Unlicense", "bzip2-1.0.6", "CDLA-Permissive-2.0", "FTL", "OFL-1.1",
              "Apache-2.0 WITH LLVM-exception", "BSD-style"}
GH = "https://raw.githubusercontent.com"

# Entries upstream registries could not classify; evidence is the upstream LICENSE text fetched for HEX-256.
MANUAL = {
    ("python", "agent-client-protocol", "0.9.0"): ("Apache-2.0", f"{GH}/agentclientprotocol/python-sdk/HEAD/LICENSE (PyPI Repository link)"),
    ("python", "hindsight-api-slim", "0.8.3"): ("MIT", f"{GH}/vectorize-io/hindsight/HEAD/LICENSE (PyPI metadata empty; project vectorize-io/hindsight, GitHub license MIT)"),
    ("python", "hindsight-client", "0.6.1"): ("MIT", f"{GH}/vectorize-io/hindsight/HEAD/LICENSE (PyPI metadata empty; author 'Hindsight Team', same monorepo)"),
    ("go-module", "github.com/docker/cli/cmd/docker", "UNKNOWN"): ("Apache-2.0", f"{GH}/docker/cli/v29.8.1/LICENSE (main module of /usr/bin/docker 29.8.1, ldflags Version=29.8.1 GitCommit=4a63305)"),
    ("go-module", "github.com/golang/freetype", "v0.0.0-20170609003504-e2365dfdc4a0"): ("FTL OR GPL-2.0-or-later", f"{GH}/golang/freetype/e2365dfdc4a05e4b8299a783240d4a7d5a65d4e4/LICENSE"),
    ("binary", "node", "26.5.1"): ("MIT", f"{GH}/nodejs/node/v26.5.1/LICENSE (bundled deps permissive; its GPL text covers only ICU4C build scripts, which are not in the binary)"),
    ("binary", "libopus-0.x64", "UNKNOWN"): ("BSD-3-Clause", f"{GH}/Rapptz/discord.py/v2.7.1/discord/bin/COPYING (Xiph Opus; shipped inside discord-py 2.7.1, MIT)"),
    ("binary", "libopus-0.x86", "UNKNOWN"): ("BSD-3-Clause", f"{GH}/Rapptz/discord.py/v2.7.1/discord/bin/COPYING (Xiph Opus; shipped inside discord-py 2.7.1, MIT)"),
    ("npm", "beep-boop", "1.2.3"): ("MIT", "example fixture inside node_modules/github-from-package (Syft: github-from-package 0.0.0, MIT)"),
}
for n in ("cli", "cli-32", "cli-64", "cli-arm64", "gui", "gui-32", "gui-64", "gui-arm64"):
    MANUAL[("binary", n, "UNKNOWN")] = ("MIT", f"setuptools Windows launcher stub inside setuptools 83.0.0 (Syft: MIT); {GH}/pypa/setuptools/v83.0.0/LICENSE")
for n, v in (("@hermes-agent/photon-sidecar", "0.4.0"), ("@hermes/ink", "0.0.1"), ("@hermes/root-tests", "UNKNOWN"),
             ("@hermes/shared", "0.0.0"), ("hermes-tui", "0.0.1"), ("hermes-whatsapp-bridge", "1.0.0"), ("web", "0.0.0")):
    MANUAL[("npm", n, v)] = ("MIT", f"first-party Hermes workspace package.json under /opt/hermes (no license field); {GH}/NousResearch/hermes-agent/HEAD/LICENSE")

TS_IMAGE = {"manifestDigest": "sha256:b333e4284c0445f55cfaf87f369714652abf5107516128469cc138e40edf1204",
            "imageID": "sha256:040824b5c0b3635443cc410db3cd33c4c92f5ab37707a479782e182eadba3187"}
TS_LAYER = "sha256:9bc271ff001f586ea7baf4966c1b9fdc3cb93674378b73b5f7123eac45ad30c1"
TS_BUILD = {"goCompiledVersion": "go1.26.8", "mainModule": "tailscale.com", "architecture": "amd64"}
TS_SETTINGS = {"-buildmode": "exe", "-compiler": "gc", "-tags": "ts_kube,ts_package_container", "-trimpath": "true",
               "CGO_ENABLED": "0", "GOARCH": "amd64", "GOOS": "linux", "GOAMD64": "v1"}
# deps_sha256: sha256 of the sorted "module version h1" lines of every go-module the binary's build info lists
# (excluding the main module and stdlib), i.e. the patched tailscale-go.sum closure actually linked in.
TS_BINARIES = {
    "/usr/local/bin/tailscale": {"sha256": "2b03b1cbe1e9a33992e71fcb31907d3830fd1e7205f1697b189e4ee6d42cd9a0",
                                 "deps": 61, "deps_sha256": "2ee4f22b1fed17ef76bce9c571da2102522cea5895d266f188d90debf5798000"},
    "/usr/local/bin/tailscaled": {"sha256": "c71196aa2fb03cd0459048626f2df704434c41c58327fac8b4e1423b0b1bbd9a",
                                  "deps": 72, "deps_sha256": "cfe101735f706bbbfeb2eb7f6a120433da196da8856f379bf3e722065b5d7687"},
}
TS_NOTICE_MAP = "HEX-303 notice-map.json (exact-version texts, inclusion/exclusion per compiled package)"

# Hashes are reviewed constants, never accepted from the evidence input. Requiring
# the complete closure also binds unlinked go.sum entries and retained module bytes.
TS_EVIDENCE = {
    "candidate_index": "5f0521ca42733e5ddd7e217660c95ce68b7fd9d207cdf070b9f9a06bcba4f123",
    "image_manifest": "b333e4284c0445f55cfaf87f369714652abf5107516128469cc138e40edf1204",
    "source_tar": "784b023e825e1cca7b146ac6a7aff08b179d60d10839b51019f315dab426c871",
    "go_mod": "b0ff5cf6556d135a2ab04f5ef4fcc89c3c89519ca7fbafe52502a8341560fda0",
    "go_sum": "09bcdebaea359c83236f137a023dbcbdcc420f0ef140b32c445cb467dfac9917",
    "source_closure": "4422144212d928c6c0fae0135fcaa999d54b9447998645e4db8ec7e81471bfab",
}

BOUND = {
    ("go-module", "tailscale.com", "UNKNOWN"): {
        "license": "BSD-3-Clause AND Apache-2.0 AND 0BSD",
        "evidence": (f"{GH}/tailscale/tailscale/v1.102.4/LICENSE + PATENTS (main module '(devel)' rebuilt from the v1.102.4 tag "
                     "tarball sha256 784b023e825e1cca7b146ac6a7aff08b179d60d10839b51019f315dab426c871 with tailscale-go.mod "
                     "sha256 b0ff5cf6556d135a2ab04f5ef4fcc89c3c89519ca7fbafe52502a8341560fda0 and tailscale-go.sum sha256 "
                     "09bcdebaea359c83236f137a023dbcbdcc420f0ef140b32c445cb467dfac9917). Linked code: Tailscale BSD-3-Clause; "
                     "Go Authors BSD-3-Clause in tempfork/{acme,heap,httprec}; Apache-2.0 in tempfork/spf13/cobra; 0BSD htmx "
                     f"2.0.4 and htmx-ext-ws 2.0.2 embedded by util/eventbus. MIT files are Windows/macOS-only and not linked. {TS_NOTICE_MAP}"),
        "image": TS_IMAGE, "layer": TS_LAYER, "build": TS_BUILD, "settings": TS_SETTINGS, "binaries": TS_BINARIES,
    },
    ("go-module", "github.com/tailscale/web-client-prebuilt", "v0.0.0-20250124233751-d4cd19a26976"): {
        "license": "",
        "unresolved": True,
        "evidence": ("UNRESOLVED: embedded web-client composition is unproven; scheduler/classnames versions are "
                     "inferred and the Inter version and candidate OFL notice are unconfirmed. Module h1 and retained "
                     "source identity do not establish complete embedded notices. Notice delivery is pending."),
        "h1": "h1:UBPHPtv8+nEAy2PD8RyAhOYvau1ek0HDJqLS/Pysi14=",
        "image": TS_IMAGE, "layer": TS_LAYER, "build": TS_BUILD, "binaries": TS_BINARIES,
    },
}


class BindingError(Exception):
    pass


def verify_evidence(paths):
    """Read all retained inputs before classification; never trust supplied hashes."""
    if not isinstance(paths, dict) or set(paths) != set(TS_EVIDENCE):
        raise BindingError("evidence must name exactly: " + ", ".join(TS_EVIDENCE))
    failures = []
    for name, expected in TS_EVIDENCE.items():
        try:
            if not isinstance(paths[name], (str, Path)):
                raise ValueError("path must be a string")
            with open(paths[name], "rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != expected:
                failures.append(f"{name}: sha256 {actual} != {expected}")
        except (OSError, ValueError, TypeError) as exc:
            failures.append(f"{name}: cannot read evidence: {exc}")
    if failures:
        raise BindingError("\n".join(failures))


def go_deps_digest(sbom, path):
    rows = sorted(f"{a['name']} {a['version']} {(a.get('metadata') or {}).get('h1Digest', '')}"
                  for a in sbom["artifacts"]
                  if a["type"] == "go-module" and a["name"] not in ("tailscale.com", "stdlib")
                  and any(loc["path"] == path for loc in a["locations"]))
    return len(rows), hashlib.sha256(("\n".join(rows) + "\n").encode()).hexdigest()


def file_sha256(sbom, path, layer):
    for f in sbom.get("files") or []:
        loc = f.get("location") or {}
        if loc.get("path") == path and loc.get("layerID") == layer:
            for d in f.get("digests") or []:
                if d.get("algorithm") == "sha256":
                    return d.get("value")
    return None


def verify_bound(key, art, sbom, spec):
    """Return the bound (license, evidence) or raise BindingError on any mismatch."""
    errs = []
    meta = ((sbom.get("source") or {}).get("metadata")) or {}
    for k, want in spec["image"].items():
        if meta.get(k) != want:
            errs.append(f"source.metadata.{k}={meta.get(k)!r} != {want!r}")
    am = art.get("metadata") or {}
    for k, want in spec["build"].items():
        if am.get(k) != want:
            errs.append(f"metadata.{k}={am.get(k)!r} != {want!r}")
    if "settings" in spec:
        got = {s.get("key"): s.get("value") for s in am.get("goBuildSettings") or []}
        if got != spec["settings"]:
            errs.append(f"goBuildSettings={got!r} != {spec['settings']!r}")
    if "h1" in spec and am.get("h1Digest") != spec["h1"]:
        errs.append(f"h1Digest={am.get('h1Digest')!r} != {spec['h1']!r}")
    locs = art.get("locations") or []
    if not locs:
        errs.append("no locations")
    for loc in locs:
        path, b = loc.get("path"), spec["binaries"].get(loc.get("path"))
        if b is None:
            errs.append(f"location {path!r} is not a verified binary")
            continue
        if loc.get("layerID") != spec["layer"]:
            errs.append(f"{path}: layerID={loc.get('layerID')!r} != {spec['layer']!r}")
        got = file_sha256(sbom, path, spec["layer"])
        if got != b["sha256"]:
            errs.append(f"{path}: file sha256={got!r} != {b['sha256']!r}")
        n, digest = go_deps_digest(sbom, path)
        if (n, digest) != (b["deps"], b["deps_sha256"]):
            errs.append(f"{path}: {n} go deps digest {digest} != {b['deps']} {b['deps_sha256']}")
    if errs:
        raise BindingError(f"{'|'.join(key)} at {','.join(sorted(l.get('path', '?') for l in locs))}: " + "; ".join(errs))
    return spec["license"], spec["evidence"]


def upstream(k, c):
    v = c.get("|".join(k)) or {}
    lic = (v.get("depsdev") or {}).get("licenses") or []
    src = v.get("sources", [])[:1]
    if k[0] == "python" and v.get("pypi"):
        p = v["pypi"]
        if p.get("license_expression"):
            lic = [p["license_expression"]]
        elif (not lic or lic == ["non-standard"]) and p.get("classifiers"):
            cl = " ".join(p["classifiers"])
            for pat, spdx in (("MIT", "MIT"), ("BSD", "BSD-style"), ("Apache", "Apache-2.0"), ("MPL 2.0", "MPL-2.0")):
                if pat in cl:
                    lic = [spdx]
                    break
            src = [s for s in v["sources"] if "pypi.org" in s][:1] or src
    if not lic and v.get("crates_io"):
        lic, src = [v["crates_io"]["license"]], [s for s in v["sources"] if "crates.io" in s][:1]
    return " AND ".join(lic), (src[0] if src else "")


def classify(lic):
    if COPYLEFT.search(lic):
        alts = [a.strip() for a in re.split(r"\s+OR\s+", lic.strip("()"))]
        if len(alts) > 1 and any(a in PERMISSIVE for a in alts):
            return "dual-permissive-available"
        return "copyleft"
    parts = [p for p in re.split(r"[()\s]+(?:AND|OR)[()\s]+|[()]", lic) if p.strip()]
    if lic and all(p.strip() in PERMISSIVE or p.strip().startswith(("MIT", "BSD")) for p in parts):
        return "permissive"
    return "unclassified"


def reconcile(sbom, cache, pins, evidence=None):
    if any((a["type"], a["name"], a["version"]) in BOUND for a in sbom["artifacts"]):
        verify_evidence(evidence)
    pinmap = {(p["type"], p["name"], p["version"]): p for p in pins.get("components", [])}
    rows, failures = [], []
    for x in sbom["artifacts"]:
        k = (x["type"], x["name"], x["version"])
        if k in BOUND:
            try:
                lic, ev = verify_bound(k, x, sbom, BOUND[k])
            except BindingError as e:
                failures.append(str(e))
                continue
        elif x["type"] == "deb" or x.get("licenses"):
            continue
        else:
            lic, ev = MANUAL.get(k) or upstream(k, cache)
        cls = classify(lic)
        pin = pinmap.get(k)
        if BOUND.get(k, {}).get("unresolved"):
            disp = "UNRESOLVED"
        elif pin:
            disp = "source-pinned (" + ", ".join(f"{s['kind']}:{s.get('name') or s.get('repo')}@{s.get('version') or s.get('ref')}" for s in pin["sources"]) + ")"
        elif cls == "permissive":
            disp = "no-source-obligation (permissive; notice only)"
        else:
            disp = "UNRESOLVED"
        rows.append({"type": x["type"], "name": x["name"], "version": x["version"],
                     "location": ",".join(sorted({l["path"] for l in x["locations"]})), "purl": x.get("purl") or "",
                     "license": lic, "class": cls, "disposition": disp, "evidence": ev})
    if failures:
        raise BindingError("\n".join(failures))
    rows.sort(key=lambda r: (r["type"], r["name"], r["version"], r["location"]))
    return rows


def load_json(path):
    with open(path) as f:
        return json.load(f)


def main(argv):
    if len(argv) != 5:
        print("Usage: license_reconcile.py SYFT_JSON UPSTREAM_CACHE PINS OUT_DIR EVIDENCE_JSON", file=sys.stderr)
        return 2
    syft, cache_path, pins_path, out, evidence_path = argv
    try:
        sbom = load_json(syft)
        evidence = load_json(evidence_path)
        if isinstance(evidence, dict):
            evidence = {k: str(Path(evidence_path).resolve().parent / v) if isinstance(v, str) else v
                        for k, v in evidence.items()}
        rows = reconcile(sbom, load_json(cache_path), load_json(pins_path), evidence)
    except (BindingError, OSError, ValueError, TypeError, KeyError) as e:
        print(f"FAIL bound classification does not match this SBOM:\n{e}", file=sys.stderr)
        return 2
    cols = ["type", "name", "version", "location", "purl", "license", "class", "disposition", "evidence"]
    with open(f"{out}/reconciliation.tsv", "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write("\t".join(r[c].replace("\t", " ") for c in cols) + "\n")
    with open(syft, "rb") as f:
        syft_sha256 = hashlib.sha256(f.read()).hexdigest()
    s = {"syft_sha256": syft_sha256,
         "evidence_sha256": TS_EVIDENCE if any((r["type"], r["name"], r["version"]) in BOUND for r in rows) else {},
         "clearance": "NOT GRANTED: reconciliation is not notice completeness or delivery verification",
         "image": (sbom.get("source") or {}).get("metadata", {}).get("manifestDigest"),
         "artifacts": len(rows), "unique": len({(r["type"], r["name"], r["version"]) for r in rows}),
         "by_type": dict(collections.Counter(r["type"] for r in rows)),
         "by_class": dict(collections.Counter(r["class"] for r in rows)),
         "unresolved": [r for r in rows if r["disposition"] == "UNRESOLVED"],
         "copyleft_or_dual": sorted({(r["type"], r["name"], r["version"], r["license"], r["disposition"]) for r in rows
                                     if r["class"] != "permissive"})}
    with open(f"{out}/reconciliation-summary.json", "w") as f:
        json.dump(s, f, indent=1)
    print(json.dumps({k: v for k, v in s.items() if k != "unresolved"}, indent=1), "\nunresolved", len(s["unresolved"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
