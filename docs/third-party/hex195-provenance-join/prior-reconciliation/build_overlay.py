"""Build additive evidence joins. Never overwrite baseline status or membership."""
import collections, hashlib, json, pathlib, shutil, sys
out=pathlib.Path(__file__).resolve().parent
base=pathlib.Path(sys.argv[1]); incoming=pathlib.Path(sys.argv[2])
def read(p): return json.loads(p.read_text())
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def write(n,x): (out/n).write_text(json.dumps(x,indent=2,ensure_ascii=False)+"\n")
shutil.copytree(incoming/"hex191/hex191-grant-triage",out/"grant-evidence",dirs_exist_ok=True)
ops=incoming/"hex190/hex190-evidence"
files=["HEX-190-summary.md","volume-SHA256SUMS","analysis/rust-membership.json","analysis/sbom-all-layers-vs-final.json","volume/notices/missing-notice-source-locator.json","volume/npm/npm-lock-vs-installed.json","volume/facts/npm-installed-packages.json","volume/upstream/upstream-fetches.json","volume/upstream/phase3.json","volume/upstream/pinned-image-binary-compare.txt","volume/rust/uv.dep-v0.json","volume/rust/uvx.dep-v0.json","volume/rust/binary-crate-evidence.json","volume/rust/bin2-binary-crate-evidence.json","volume/facts/ensurepip.json","volume/facts/uv-cache-structure.json","volume/facts/npm-cache-cacache.json"]
for n in files:
 dest=out/"source-evidence"/n;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ops/n,dest)
b=read(base/"reconciliation.json");grants=read(out/"grant-evidence/hex191-grant-triage.json")["rows"]
loc=read(ops/"volume/notices/missing-notice-source-locator.json")
installed=read(ops/"volume/facts/npm-installed-packages.json")
locks=read(ops/"volume/npm/npm-lock-vs-installed.json")
idx=collections.defaultdict(list)
for i,r in enumerate(installed): idx[(r.get("dir"),r.get("name"),str(r.get("version") or "UNKNOWN"))].append(i)
lidx=collections.defaultdict(list)
for i,r in enumerate(locks):
 if r.get("installed_dir_present"):lidx[(str(pathlib.PurePosixPath(r["lock"]).parent/r["key"]),str(r.get("installed_version")))].append(i)
scope=read(out/"workspace-scope.json")
rows=[];textrefs=[]
for row in b["rows"]:
 r={"baseline_row_index":row["baseline_row_index"],"kind":row["kind"],"name":row["name"],"version":row["version"],"source_status":"not_reconciled","grant_evidence_rows":[],"retained_source_evidence_rows":[],"npm_final_instances":[]}
 for i,g in enumerate(grants):
  ecosystem=("npm" in g["ecosystem"] and row["kind"]=="sbom-npm") or ("pypi" in g["ecosystem"] and row["kind"] in ("python","sbom-python")) or ("cargo" in g["ecosystem"] and row["kind"] in ("pg0-rust","sbom-rust-crate","cua-rust-lock-candidate"))
  if ecosystem and (g["row"],g["version"])==(row["name"],row["version"]):
   r["grant_evidence_rows"].append(i);r["notice_disposition"]=g["disposition"]
 for i,l in enumerate(loc):
  if all(l.get(k)==row.get(k) for k in ("kind","name","version")) and (not l.get("environment") or l["environment"]==row.get("environment")):
   if l.get("locations") and set(l["locations"])!={x.get("path") for x in row.get("locations",[])}:continue
   r["retained_source_evidence_rows"].append(i)
 if row["kind"]=="sbom-npm":
  for location in row.get("locations",[]):
   path=location.get("path","")
   if not path.endswith("/package.json"):continue
   d=str(pathlib.PurePosixPath(path).parent)
   for i in idx.get((d,row["name"],str(row["version"])),[]):
    r["npm_final_instances"].append({"package_row":i,"path":path,"lock_evidence_rows":lidx.get((d,str(row["version"])),[])})
  r["final_membership_evidence"]="exact_path_name_version_observed" if r["npm_final_instances"] else "not_joined_do_not_infer_absence"
 if row["name"]=="web" and row["kind"]=="sbom-npm":
  r["rejected_prior_associations"]={"records":row["upstream_records"],"reason":"Registry web@0.0.0 is unrelated to /opt/hermes/web. Preserve record only as rejected evidence, never as a grant."}
 if r.get("notice_disposition")=="not_a_package_fixture":
  r["notice_disposition"]="containing_package_fixture_candidate"
  if all("/github-from-package/example/package.json" in l.get("path","") for l in row.get("locations",[])) and row.get("locations"):
   r["notice_disposition"]="containing_package_fixture_path_verified"
 r["workspace_scope_rows"]=[i for i,x in enumerate(scope) if x.get("baseline_row_index")==row["baseline_row_index"]]
 if r["workspace_scope_rows"]:
  r["notice_disposition"]="exact_retained_source_root_notice_association"
 rows.append(r)
for i,g in enumerate(grants):
 for t in g.get("texts",[]):
  h=t["sha256"];p=out/"grant-evidence"/t["file"]
  if not p.is_file():p=base/"texts"/(h+".txt")
  assert p.is_file(),(g["row"],p)
  assert digest(p)==h
  if "bytes" in t:assert p.stat().st_size==t["bytes"]
  textrefs.append({"grant_row":i,"sha256":h,"scope":t.get("scope"),"location":str(p.relative_to(out)) if p.is_relative_to(out) else "../hex189-supplement/texts/"+h+".txt"})
write("text-references.json",textrefs)
write("overlay.json",{"complete":False,"source_commit":b["source_commit"],"image":b["image"],"baseline_reconciliation_sha256":digest(base/"reconciliation.json"),"policy":"Additive evidence only. Original rows, membership and source_status are unchanged. Research dispositions do not authorize distribution. Post-release and tag-bound evidence never becomes exact-release closure.","rows":rows})
write("residual-review.json",{"complete":False,"rows":[r for r in rows if r["baseline_row_index"] in {x["baseline_row_index"] for x in read(base/"remaining-gaps.json")["rows"]}],"additional_grant_reviews":[{"row_index":i,"row":g["row"],"disposition":g["disposition"]} for i,g in enumerate(grants) if g["decision_for_mindi"] or g["disposition"].startswith("gap_")]})
write("summary.json",{"baseline_rows":len(rows),"grant_matched_rows":sum(bool(r["grant_evidence_rows"]) for r in rows),"locator_matched_rows":sum(bool(r["retained_source_evidence_rows"]) for r in rows),"npm_rows":sum(r["kind"]=="sbom-npm" for r in rows),"npm_exact_final_path_rows":sum(bool(r["npm_final_instances"]) for r in rows),"npm_with_lock_evidence_rows":sum(any(i["lock_evidence_rows"] for i in r["npm_final_instances"]) for r in rows),"verified_grant_text_references":len(textrefs),"notice_dispositions":dict(collections.Counter(r.get("notice_disposition","unchanged") for r in rows))})
print((out/"summary.json").read_text())
