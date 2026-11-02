import os, pathlib, subprocess, shutil, json, sys
root=pathlib.Path('/Users/zhvala/SourceCode/zody')
os.chdir(root)
label=sys.argv[1]
base=root/'output/cua-launchservices'
build=base/('controller-build-'+label)
signed=base/('controller-signed-'+label)
ui=base/('controller-ui-'+label)
checks=base/'independent-checks'
node='/Users/zhvala/.local/share/fnm/node-versions/v24.14.0/installation/bin/node'
env=dict(os.environ,PATH=str(pathlib.Path(node).parent)+':'+os.environ['PATH'])
results=[]
def run(argv, log):
 with (checks/log).open('w') as f:r=subprocess.run(argv,env=env,stdout=f,stderr=subprocess.STDOUT)
 results.append({'argv':argv,'exitCode':r.returncode,'log':log})
 (checks/('rebuild-'+label+'.json')).write_text(json.dumps(results,indent=2)+'\n')
 print(log,r.returncode,flush=True)
 if r.returncode:raise SystemExit(r.returncode)
run([node,'packages/desktop/scripts/build-cua-desktop-session.mjs','--output-root',str(build)],'build-'+label+'.log')
signed.mkdir()
app=signed/'Zody CUA Desktop Session.app'
shutil.copytree(build/'helper/Zody CUA Desktop Session.app',app,symlinks=True)
leaf='d2ad8f4bb39ad7dd13ceba3892cadb16659a4732'
req='=designated => identifier "io.github.zclaudia.zody.cua-helper" and certificate leaf = H"'+leaf+'"'
run(['codesign','--force','--sign',leaf,'--options','runtime','--timestamp=none','--requirements',req,str(app)],'sign-'+label+'.log')
run(['codesign','--verify','--strict','--verbose=2',str(app)],'verify-helper-'+label+'.log')
run(['codesign','--verify','--strict','--verbose=2',str(app/'Contents/Resources/node')],'verify-node-'+label+'.log')
run([node,'packages/desktop/scripts/build-cua-desktop-candidate-app.mjs','--helper-app',str(app),'--output',str(ui)],'ui-build-'+label+'.log')
packaged_helper=ui/'Zody CUA Launchservices Candidate.app/Contents/Resources/cua-helper/ZCode Computer Use.app'
run(['codesign','--verify','--strict','--verbose=2',str(packaged_helper)],'verify-packaged-helper-'+label+'.log')
run(['codesign','--verify','--strict','--verbose=2',str(packaged_helper/'Contents/Resources/node')],'verify-packaged-node-'+label+'.log')
