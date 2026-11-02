import os,sys,json,subprocess,datetime,time,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parents[2]
base=root/'output/cua-arm64-default-enable'
checks=base/'independent-checks'; checks.mkdir(exist_ok=True)
node=pathlib.Path('/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin/node')
env=dict(os.environ,PATH=str(node.parent)+':'+os.environ['PATH'])
guard=base/'metadata-pins.json'
if guard.exists():
 for name,expected in json.loads(guard.read_text()).items():
  actual=hashlib.sha256((root/name).read_bytes()).hexdigest()
  if actual!=expected:
   raise SystemExit('Workspace metadata guard failed: '+name)
label=sys.argv[1]; argv=json.loads(sys.argv[2]); cwd=sys.argv[3] if len(sys.argv)>3 else str(root)
start=datetime.datetime.now(datetime.timezone.utc); then=time.monotonic()
with (checks/(label+'.log')).open('w') as out:
 result=subprocess.run(argv,cwd=cwd,env=env,stdout=out,stderr=subprocess.STDOUT)
data={'name':label,'argv':argv,'cwd':cwd,'startedAt':start.isoformat(),'seconds':round(time.monotonic()-then,3),'exitCode':result.returncode,'log':label+'.log'}
(checks/(label+'.json')).write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data,indent=2),flush=True)
sys.exit(result.returncode)
