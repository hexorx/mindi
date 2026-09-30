import json,hashlib,base64
from pathlib import Path
p=Path(__file__).resolve().parent
def read(n):return json.loads((p/n).read_text())
def sha(f):return hashlib.sha256(f.read_bytes()).hexdigest()
def manifest(rel,missing=()):
 f=p/rel; n=0; absent=[]
 for line in f.read_text().splitlines():
  h,name=line.split(maxsplit=1); x=f.parent/name.lstrip('*')
  assert x.resolve().is_relative_to(f.parent.resolve())
  if not x.is_file():absent.append(name);continue
  assert sha(x)==h,(rel,name)
  n+=1
 assert set(absent)==set(missing),(rel,absent)
 return n
counts={n:manifest(n) for n in ['opi-evidence/MANIFEST.sha256','prior-reconciliation/SHA256SUMS','prior-disposition/SHA256SUMS']}
counts['volume_available']=manifest('opi-evidence/volume/SHA256SUMS',('./bin/docker',))
prior=read('prior-reconciliation/overlay.json'); rows={r['baseline_row_index']:r for r in prior['rows']}
assert len(rows)==4164
assert (p/'prior-reconciliation/residual-review.json').read_bytes()==(p/'prior-disposition/prior-residual-review.json').read_bytes()
npm=read('npm-evidence-joins.json'); opi=read('opi-evidence/npm-30-join.json'); raw=read('opi-evidence/volume/facts/npm-30.json')
assert npm['image']==opi['subject_image']==prior['image']
assert npm['source_commit']==opi['source']==prior['source_commit']
assert len(npm['rows'])==30 and len({x['baseline_row']['baseline_row_index'] for x in npm['rows']})==30
assert [x['new_final_filesystem_evidence'] for x in npm['rows']]==opi['rows']
rawrows={r['baseline_row_index']:r for r in raw['rows']};apt=(p/'opi-evidence/apt-lock-identity-rows.tsv').read_text();owners=set(); fixture=0
for j in npm['rows']:
 b=j['baseline_row'];r=j['new_final_filesystem_evidence'];i=b['baseline_row_index']
 assert b==rows[i] and b['kind']=='sbom-npm' and not b['npm_final_instances']
 assert j['source_status']==b['source_status']=='not_reconciled'
 assert b['name']==r['name']==r['package_json_name'] and b['version']==r['version']==r['package_json_version']
 assert r['final_status']==rawrows[i]['status']=='present_exact'
 instances=[x for x in rawrows[i]['exact_instances'] if x['package_json']==r['path']];assert len(instances)==1
 x=instances[0]
 for key in ['package_json_sha256','dir_manifest_sha256','dir_file_count']: assert r[key]==x[key]
 assert len(r['package_json_sha256'])==64
 if r['dpkg_owner']:
  owner=r['dpkg_owner'];owners.add(owner)
  assert x['dpkg']['md5_match'] and r['dpkg_md5sums_match'] and owner in x['dpkg']['owner_path']
  assert x['dpkg']['md5_actual']==x['dpkg']['md5sums_expected']
  v=raw['owner_dpkg_verify'][owner];assert v['rc']==0 and not v['stdout']
  assert r['npm_lock_resolved'] is None and r['npm_lock_integrity'] is None
  matches=[line for line in apt.splitlines() if '\t'+owner+'\t'+r['dpkg_owner_version']+'\t' in line];assert len(matches)==1
  assert r['apt_lock_deb_url'] in matches[0] and r['apt_lock_deb_sha256'] in matches[0]
 else:
  fixture+=1;assert r['name']=='beep-boop' and r['containing_package']=='github-from-package@0.0.0'
  assert r['containing_lock_integrity'].startswith('sha512-') and r['containing_lock_resolved'].endswith('github-from-package-0.0.0.tgz')
assert len(owners)==10 and fixture==1
j=read('docker-evidence-join.json');d=read('opi-evidence/volume/facts/docker.json');assert j['binary_facts']==d
assert j['baseline_rows']==[rows[2635],rows[385]] and rows[2635]['version']=='UNKNOWN'
assert d['dpkg']['md5_match'] and d['md5']==d['dpkg']['md5_actual']==d['dpkg']['md5sums_expected']
assert d['dpkg_verify_docker_cli']['rc']==0 and not d['dpkg_verify_docker_cli']['stdout']
assert d['sha256']==j['deb_binary_sha256']
debsha=(p/'opi-evidence/volume/deb/deb.sha256').read_text().split()[0]
for f in (p/'opi-evidence/volume/deb').glob('signed-*/packages-docker-cli.txt'):assert debsha in f.read_text() and '26.1.5+dfsg1-9+b13' in f.read_text()
n=read('native-evidence-joins.json');assert n['image']==prior['image'] and n['source_commit']==prior['source_commit'] and n['release_ready'] is False
for name in ['ffmpeg','chrome','claude']: assert n[name]['facts']==read(f'opi-evidence/volume/facts/{name}.json')
assert n['ffmpeg']['baseline_rows']==[rows[387]] and n['claude']['baseline_rows']==[rows[160],rows[2253]]
f=n['ffmpeg']['facts']['binaries'];assert len(f)==2
static=next(x for x in f if x['elf']['statically_linked']); dynamic=next(x for x in f if not x['elf']['statically_linked'])
assert not static['gpl'] and dynamic['gpl'];assert '--enable-gpl' in dynamic['buildconf']['stdout']
compare=(p/'opi-evidence/upstream-binary-compare.txt').read_text()
assert static['sha256'] in compare
assert n['chrome']['facts']['binaries'][0]['sha256'] in compare
c=n['claude']['facts']['bundled'][0]; record=c['record']['line'].split(',');assert record[1]=='sha256='+base64.urlsafe_b64encode(bytes.fromhex(c['sha256'])).decode().rstrip('=')
assert int(record[2])==c['size']==240327864
if (p/'SHA256SUMS').exists():counts['output']=manifest('SHA256SUMS')
print(json.dumps({'result':'PASS','manifest_verified':counts,'preserved_baseline_rows':len(rows),'npm_rows':30,'npm_dpkg_rows':29,'npm_fixture_rows':1,'source_status_changes':0,'volume_missing':['bin/docker'],'verification_scope':'attachment bytes and recorded evidence consistency; no runtime rerun'},indent=2))
