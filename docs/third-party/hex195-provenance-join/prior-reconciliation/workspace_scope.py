import csv,gzip,hashlib,json,pathlib,sys,tarfile,tomllib
out=pathlib.Path(__file__).resolve().parent;inc=pathlib.Path(sys.argv[1]);base=pathlib.Path(sys.argv[2])
hashb=lambda b:hashlib.sha256(b).hexdigest()
rows=json.loads((base/"reconciliation.json").read_text())["rows"]
with gzip.open(inc/"hex190/hex190-evidence/volume/facts/retained-file-manifest.tsv.gz","rt") as f:final={r["path"]:r for r in csv.DictReader(f,delimiter="\t")}
(out/"scope-bytes").mkdir(exist_ok=True)
def retain(t,m):
 b=t.extractfile(m).read();h=hashb(b);p="scope-bytes/"+h+".txt";(out/p).write_bytes(b);return {"member":m.name,"sha256":h,"bytes":len(b),"file":p}
result=[]
for file in inc.glob("*.tar.gz"):
 if not file.name.startswith(("cua-","hermes-agent-","tailscale-go-")):continue
 sha=hashb(file.read_bytes())
 with tarfile.open(file) as t:
  ms={m.name:m for m in t.getmembers() if m.isfile()};root=next(iter(ms)).split("/")[0];rel={k[len(root)+1:]:v for k,v in ms.items()}
  notice=retain(t,rel["LICENSE.md" if file.name.startswith("cua-") else "LICENSE"])
  common={"archive":file.name,"archive_sha256":sha,"identity_evidence":"source-evidence/volume-SHA256SUMS","notice":notice,"status":"exact_retained_source_root_notice_association","full_closure":False}
  if file.name.startswith("cua-"):
   work=tomllib.loads(t.extractfile(rel["libs/cua-driver/rust/Cargo.toml"]).read().decode())
   for r in rows:
    if r["kind"]!="cua-rust-lock-candidate" or r.get("supplement_status")!="workspace_source_candidate":continue
    candidates=[]
    for n,m in rel.items():
     if not n.endswith("/Cargo.toml"):continue
     d=tomllib.loads(t.extractfile(m).read().decode()).get("package",{})
     if d.get("name")!=r["name"]:continue
     v=d.get("version");v=work["workspace"]["package"]["version"] if isinstance(v,dict) else v
     assert v==r["version"]
     candidates.append({"declaration":retain(t,m),"declared_license":d.get("license"),"workspace_license":work["workspace"]["package"]["license"],"workspace_declaration":retain(t,rel["libs/cua-driver/rust/Cargo.toml"])})
    assert len(candidates)==1
    result.append(dict(common,baseline_row_index=r["baseline_row_index"],name=r["name"],version=r["version"],package=candidates[0],membership="All-platform source-lock superset; root notice does not prove binary membership."))
  elif file.name.startswith("hermes-agent-"):
   names={"hermes-agent","hermes-tui","hermes-whatsapp-bridge","@hermes/ink","@hermes/root-tests","@hermes/shared","@hermes-agent/photon-sidecar","web"}
   for r in rows:
    if r["kind"]!="sbom-npm" or r["name"] not in names:continue
    for l in r["locations"]:
     path=l["path"];n=path.removeprefix("/opt/hermes/");m=rel[n];b=t.extractfile(m).read();d=json.loads(b)
     assert (d["name"],str(d.get("version") or "UNKNOWN"))==(r["name"],r["version"])
     f=final[path];same=hashb(b)==f["sha256"]
     result.append(dict(common,baseline_row_index=r["baseline_row_index"],name=r["name"],version=r["version"],declaration=retain(t,m),final_path=path,final_file_evidence=f,source_package_json_matches_final=same,status="source_and_final_declaration_match_root_notice_association" if same else "source_candidate_final_declaration_differs",scope="Own workspace source only; nested dependencies/fonts/native payloads retain separate obligations."))
  else:result.append(dict(common,name="tailscale/go",version="7275f792d406d3c386cc807937a45a4a7b699d42",scope="Exact Tailscale toolchain fork root notice; generic upstream Go 1.26.6 is not sufficient identity for this fork."))
(out/"workspace-scope.json").write_text(json.dumps(result,indent=2)+"\n")
print("Scope associations",len(result),"Hermes final byte matches",sum(r.get("source_package_json_matches_final",False) for r in result))
