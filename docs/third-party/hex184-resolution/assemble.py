#!/usr/bin/env python3
"""Assemble captured HEX-184 bytes; no network, execution of artifacts, or repo changes."""
import argparse,base64,collections,hashlib,json,pathlib,re,tarfile,tomllib
p=argparse.ArgumentParser();p.add_argument('evidence',type=pathlib.Path);p.add_argument('output',type=pathlib.Path);a=p.parse_args();r=a.evidence;o=a.output;o.mkdir(parents=True,exist_ok=True)
def digest(b):return hashlib.sha256(b).hexdigest()
def write(name,obj):(o/name).write_text(json.dumps(obj,indent=2,sort_keys=True)+'\n')
manifest=[];rows=[];by_path={};crate_texts=collections.defaultdict(list)
def add(data,source,path,expected=None):
 h=digest(data)
 if expected and expected!=h:raise ValueError('Hash mismatch '+path)
 dest='texts/'+h+'.txt';(o/'texts').mkdir(exist_ok=True);(o/dest).write_bytes(data)
 rec={'file':dest,'sha256':h,'bytes':len(data),'evidence':source,'original_path':path};manifest.append(rec);by_path.setdefault(path.lstrip('./'),[]).append(dest);return dest
def notices(pkg,source):return sorted(set(add(base64.b64decode(n['content_base64'],validate=True),source,n['path'],n['sha256']) for n in pkg['notices']))
def row(kind,name,version,texts,**kw):
 rows.append(dict(kind=kind,name=name,version=version,texts=sorted(set(texts)),text_status='captured_needs_review' if texts else 'missing',source_status='not_reconciled',**kw))
checks=[]
for folder in ['run','followup']:
 for line in (r/folder/'SHA256SUMS').read_text().splitlines():
  h,n=line.split(None,1);f=r/folder/n.strip()
  if f.is_file():
   assert digest(f.read_bytes())==h, str(f);checks.append(str(f.relative_to(r)))
for archive in ['run/notices/other-notices.tar','run/rust/pg0-crate-notices.tar','followup/pg0-embedded-bundle-notices.tar']:
 with tarfile.open(r/archive) as t:
  for m in t:
   if not m.isfile():continue
   # .control files are metadata, never license text.
   if not re.search(r'(?i)(license|licence|copying|copyright|notice)',pathlib.PurePosixPath(m.name).name):continue
   ref=add(t.extractfile(m).read(),archive,m.name)
   if archive.endswith('pg0-crate-notices.tar'):
    parts=m.name.split('/');idx=parts.index('index.crates.io-1949cf8c6b5b557f');crate_texts[parts[idx+1]].append(ref)
debian={}
for inv in sorted(r.glob('run/inventory/*.json')):
 d=json.loads(inv.read_text());src=str(inv.relative_to(r))
 for pkg in d.get('debian',[]):
  refs=notices(pkg,src);debian[pkg['name']]=refs
  row('debian',pkg['name'],pkg['version'],refs,source_package=pkg['source_package'],source_version=pkg['source_version'],architecture=pkg['architecture'],source_action='Retain copyright/common-license bytes; reconcile exact source archives, patches and build materials before redistribution; text presence does not settle source duties.')
 for n in d.get('debian_common_licenses',[]):add(base64.b64decode(n['content_base64'],validate=True),src,n['path'],n['sha256'])
 for pkg in d['python']['packages']:
  refs=notices(pkg,src)
  row('python',pkg['name'],pkg['version'],refs,environment=d['python']['executable'],license_expression=pkg.get('license_expression'),license_metadata=pkg.get('license_metadata'),source_action='Review exact wheel/source and bundled native libraries; distribution license metadata alone is not closure.')
# Explicit Debian package mappings, preserving source and binary versions separately.
for v in rows:
 if v['kind']=='python' and v['environment']=='/usr/bin/python3':
  n=v['name'].lower().replace('_','-');n={'deprecated':'deprecated','pyyaml':'yaml','typing-extensions':'typing-extensions'}.get(n,n);key='python3-'+n
  if key in debian:v['texts']=debian[key];v['text_status']='debian_package_text_candidate';v['debian_package']=key
metadata=json.loads((r/'followup/pg0-cargo-metadata.linux-x86_64.json').read_text())
for pkg in metadata['packages']:
 row('pg0-rust',pkg['name'],pkg['version'],crate_texts[pkg['name']+'-'+pkg['version']],license_expression=pkg.get('license'),cargo_id=pkg['id'],source=pkg.get('source'),membership='linux-filtered cargo metadata; build/runtime and optional membership require review')
cua=r/'supplemental/cua-driver-source-039783f9';cua_ref=add((cua/'LICENSE.md').read_bytes(),'supplemental/cua-driver-source-039783f9/LICENSE.md','cua/LICENSE.md')
row('cua-driver','cua-driver','0.30.1',[cua_ref],source_revision='039783f9221a08c0daf9cda65a460fc4f346fa6e',source_action='MIT root text captured; tag lock is an all-platform superset, not a verified binary dependency closure.')
lock=tomllib.loads((cua/'libs_cua-driver_rust_Cargo.lock').read_text())
for pkg in lock['package']:
 refs=crate_texts[pkg['name']+'-'+pkg['version']] if pkg.get('source','').startswith('registry+') else []
 row('cua-rust-lock-candidate',pkg['name'],pkg['version'],refs,source=pkg.get('source'),checksum=pkg.get('checksum'),membership='unverified all-platform lock superset; shared crate texts are version candidates only')
sbom=json.loads((r/'run/sbom/sbom.syft.json').read_text())
for pkg in sbom['artifacts']:
 if pkg['type'] in ('deb',):continue
 paths=[x['path'] for x in pkg.get('locations',[])];refs=[]
 if pkg['type']=='npm':
  for loc in paths:
   parent=str(pathlib.PurePosixPath(loc).parent).lstrip('/')+'/'
   for path,files in by_path.items():
    if path.startswith(parent) and '/node_modules/' not in path[len(parent):]:refs.extend(files)
 if pkg['type']=='rust-crate':refs=crate_texts[pkg['name']+'-'+pkg['version']]
 if pkg['type']=='python':
  for v in rows:
   if v['kind']=='python' and re.sub('[-_.]','-',v['name'].lower())==re.sub('[-_.]','-',pkg['name'].lower()) and v['version']==pkg['version']:refs.extend(v['texts'])
 row('sbom-'+pkg['type'],pkg['name'],pkg['version'],refs,artifact_id=pkg['id'],locations=pkg.get('locations',[]),purl=pkg.get('purl'),declared_licenses=pkg.get('licenses',[]),source_metadata=pkg.get('metadata',{}),membership='all-layer scan; text association is a candidate, final filesystem/layer membership unverified')
for name,version in [('s6-overlay','3.2.3.0'),('s6','2.15.0.0'),('s6-rc','0.6.1.0'),('execline','2.9.9.0'),('s6-linux-init','1.2.0.1'),('s6-linux-utils','2.6.4.1'),('s6-portable-utils','2.3.1.2'),('s6-overlay-helpers','0.1.2.2')]:row('inherited-s6',name,version,[],source_action='Collect version-specific upstream texts and source/build provenance; absent from SBOM.')
row('inherited-hermes','hermes','e624e9fde561e1add9388384012b295fde669ade',by_path.get('opt/hermes/LICENSE',[]),source_action='Reconcile source revision and changes separately; preserve extraction source grant.')
for name,version in [('PostgreSQL','18.1.0'),('pgvector','0.8.1'),('libxml2','2.9.13+dfsg-1ubuntu0.11'),('libicu70','70.1-2ubuntu1')]:
 refs=[m['file'] for m in manifest if m['evidence']=='followup/pg0-embedded-bundle-notices.tar' and 'postgresql-' in m['original_path']] if name=='PostgreSQL' else []
 row('pg0-embedded',name,version,refs,source_action='Reconcile exact embedded artifact and its source; do not substitute host Debian copyright for Ubuntu libraries.')
row('retained-cache','/root/.npm','image-55422e9b',[],source_action='Reconcile cached tarball identities and nested license/notice bytes; npm filesystem matches do not cover cache contents.')
row('retained-cache','/root/.cache/uv','image-55422e9b',[m['file'] for m in manifest if m['original_path'].startswith('root/.cache/uv/')],source_action='Only six non-dist-info cache texts captured; reconcile each retained wheel/sdist/build tree, including python-olm/libolm.')
write('manifest.json',{'schema_version':1,'complete':False,'image':'sha256:55422e9bab38e8be3cf1d28294acbd854dffafd23c9d0d6656da7a1589ee521c','base_commit':'352b6eb5331030019eb26033675d2ab53d47459d','notices':manifest})
write('reconciliation.json',{'schema_version':1,'complete':False,'rows':rows})
write('verification.json',{'verified_evidence_files':checks,'notice_records':len(manifest),'unique_texts':len(list((o/'texts').iterdir())),'inventory_rows':len(rows),'rows_without_text':sum(not v['texts'] for v in rows),'by_kind':{k:dict(rows=sum(v['kind']==k for v in rows),missing_text=sum(v['kind']==k and not v['texts'] for v in rows)) for k in sorted(set(v['kind'] for v in rows))},'malformed_capture':'run/rust/pg0-source-notices.tar contains a directory listing followed by other output, not a valid tar; not treated as notice bytes'})
print((o/'verification.json').read_text())
