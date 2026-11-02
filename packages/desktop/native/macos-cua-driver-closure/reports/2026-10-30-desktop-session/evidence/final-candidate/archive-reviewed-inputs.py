import pathlib,json,hashlib,tarfile,io,sys,shutil,subprocess,difflib
root=pathlib.Path('/Users/zhvala/SourceCode/zody')
label=sys.argv[1]
base=root/'output/cua-desktop-session'
audit=base/('controller-build-'+label)/'build/audit'
out=base/('frozen-'+label)
out.mkdir()
inputs={}
for p in audit.glob('*.inputs.json'):
 for name,sha in json.loads(p.read_text()).items():
  if name in inputs and inputs[name]!=sha:raise RuntimeError('conflicting input '+name)
  inputs[name]=sha
for name,sha in inputs.items():
 p=root/name
 if p.is_absolute() and not str(p).startswith(str(root)+'/'):raise RuntimeError('outside project '+name)
 if hashlib.sha256(p.read_bytes()).hexdigest()!=sha:raise RuntimeError('input changed '+name)
with tarfile.open(out/'actual-bundle-inputs.tar.gz','w:gz') as tar:
 for name in sorted(inputs):
  data=(root/name).read_bytes();info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;info.mtime=0;tar.addfile(info,io.BytesIO(data))
(out/'actual-bundle-inputs.json').write_text(json.dumps(inputs,indent=2)+'\n')
shutil.copytree(audit,out/'audit')
shutil.copy2(audit.parent/'build-manifest.json',out/'build-manifest.json')
old={r['path']:r['sha256'] for r in json.loads((base/'opening-files.json').read_text())}
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
prefixes=('apps/zcode-cli/','packages/desktop/src/','packages/desktop/scripts/','packages/desktop/native/macos-cua-desktop-session/','packages/services/src/','specs/computer-use','docs/plans/computer-use')
changed=[];patch=[]
for name in sorted(set(files)):
 if not name or not (name.startswith(prefixes) or name=='packages/desktop/tsup.config.ts'):continue
 p=root/name
 if not p.is_file():continue
 data=p.read_bytes();sha=hashlib.sha256(data).hexdigest()
 if old.get(name)==sha:continue
 changed.append({'path':name,'openingSha256':old.get(name),'sha256':sha})
 target=out/'source'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
 before=base/'preimages'/name
 if old.get(name) is not None and not before.is_file():raise RuntimeError('missing preimage '+name)
 b=before.read_bytes() if before.is_file() else b''
 if old.get(name) is not None and hashlib.sha256(b).hexdigest()!=old[name]:raise RuntimeError('wrong preimage '+name)
 try:patch.extend(difflib.unified_diff(b.decode().splitlines(True),data.decode().splitlines(True),fromfile='a/'+name,tofile='b/'+name))
 except UnicodeDecodeError:raise RuntimeError('binary change requires explicit archive '+name)
(out/'changes-from-opening.patch').write_text(''.join(patch))
(out/'changed-source.json').write_text(json.dumps(changed,indent=2)+'\n')
manifest={}
for p in sorted(out.rglob('*')):
 if p.is_file():manifest[str(p.relative_to(out))]=hashlib.sha256(p.read_bytes()).hexdigest()
(out/'sha256.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'inputs':len(inputs),'changedFiles':len(changed),'manifestSha256':hashlib.sha256((out/'sha256.json').read_bytes()).hexdigest(),'output':str(out)}))
