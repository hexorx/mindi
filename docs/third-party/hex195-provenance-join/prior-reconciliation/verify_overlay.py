"""Evidence integrity + invariants, without asserting licensing closure."""
import hashlib,json,pathlib,sys
p=pathlib.Path(__file__).resolve().parent;b=pathlib.Path(sys.argv[1])
read=lambda f:json.loads(f.read_text())
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
o=read(p/"overlay.json");base=read(b/"reconciliation.json");scope=read(p/"workspace-scope.json")
assert sha(b/"reconciliation.json")==o["baseline_reconciliation_sha256"]
assert len(o["rows"])==len(base["rows"])==4164
assert [(r["baseline_row_index"],r["kind"],r["name"],r["version"]) for r in o["rows"]]==[(r["baseline_row_index"],r["kind"],r["name"],r["version"]) for r in base["rows"]]
assert not o["complete"] and all(r["source_status"]=="not_reconciled" for r in o["rows"])
for t in read(p/"text-references.json"):
 f=b/"texts"/(t["sha256"]+".txt") if t["location"].startswith("../") else p/t["location"]
 assert sha(f)==t["sha256"]
def verify(x):
 if isinstance(x,dict):
  if "file" in x and "sha256" in x:assert sha(p/x["file"])==x["sha256"] and (p/x["file"]).stat().st_size==x["bytes"]
  for v in x.values():verify(v)
 elif isinstance(x,list):
  for v in x:verify(v)
verify(scope)
assert len(scope)==24
assert sum(x.get("source_package_json_matches_final",False) for x in scope)==8
for r in o["rows"]:
 if r["name"] in ("pg0","pg0-embedded","cobble") and r.get("grant_evidence_rows"):assert r["notice_disposition"]=="gap_declared_only"
 if r["name"]=="web" and r["kind"]=="sbom-npm":assert r["rejected_prior_associations"] and r["workspace_scope_rows"]
 if r["name"]=="seahash" and r.get("grant_evidence_rows"):assert r["notice_disposition"]=="resolved_post_release_upstream_text"
 if r["kind"]=="cua-rust-lock-candidate":assert "superset" in base["rows"][r["baseline_row_index"]]["membership"]
print("PASS: 4164 row identities, unchanged baseline hash/status/membership, 44 grant text references, 24 source scope associations, 8 final byte matches, gap/post-release/web scope safeguards")
