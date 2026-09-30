#!/usr/bin/env python3
"""Verify bytes, references, known inventory counts, and conservative status."""
import hashlib,json,pathlib,sys

def verify(root,manifest=None):
 root=pathlib.Path(root);m=manifest or json.loads((root/'manifest.json').read_text());r=json.loads((root/'reconciliation.json').read_text())
 assert m['complete'] is False and r['complete'] is False
 known=set()
 for n in m['notices']:
  assert n['file']=='texts/'+n['sha256']+'.txt'
  data=(root/n['file']).read_bytes()
  assert len(data)==n['bytes'] and hashlib.sha256(data).hexdigest()==n['sha256'], n['original_path']
  assert n['evidence'] and n['original_path'];known.add(n['file'])
 for v in r['rows']:
  assert set(v['texts'])<=known
  assert v['source_status']=='not_reconciled'
  assert bool(v['texts'])==(v['text_status']!='missing')
 for kind,count in {'debian':533,'python':368,'pg0-rust':239,'cua-rust-lock-candidate':635,'sbom-npm':802,'sbom-go-module':139,'sbom-rust-crate':1010}.items():
  assert sum(v['kind']==kind for v in r['rows'])==count,kind
 assert all(v['texts'] for v in r['rows'] if v['kind']=='debian')
 assert len(known)==len(list((root/'texts').glob('*')))
 return len(known),len(r['rows'])
if __name__=='__main__':print('PASS unique texts, reconciliation rows:',verify(sys.argv[1]))
