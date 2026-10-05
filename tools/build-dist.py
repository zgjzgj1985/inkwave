# Assemble dist/: the game files plus only the three.js addons the game imports (and their deps).
import re, os, shutil, glob
root = 'vendor/three/jsm'
keep = {'.vercel', 'vercel.json'}
if os.path.isdir('dist'):
    for n in os.listdir('dist'):
        if n in keep: continue
        p = os.path.join('dist', n)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
else:
    os.makedirs('dist')
need = set()
for f in glob.glob('src/**/*.js', recursive=True):
    need |= {m for m in re.findall(r"three/addons/([A-Za-z0-9_./-]+\.js)", open(f).read())}
need, seen = list(need), set()
while need:
    f = need.pop()
    if f in seen: continue
    seen.add(f)
    for m in re.findall(r"from\s+['\"](\.[^'\"]+)['\"]", open(os.path.join(root, f)).read()):
        need.append(os.path.normpath(os.path.join(os.path.dirname(f), m)))
for f in seen:
    d = os.path.join('dist/vendor/three/jsm', f); os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copy(os.path.join(root, f), d)
os.makedirs('dist/vendor/three/build', exist_ok=True)
for f in ['three.module.js', 'three.core.js']: shutil.copy('vendor/three/build/' + f, 'dist/vendor/three/build/' + f)
for d in ['src', 'styles', 'assets', 'songs']: shutil.copytree(d, 'dist/' + d)
shutil.copy('index.html', 'dist/index.html')
# Device diagnostics that ship. These two are the only pages under tools/ that are self-contained — styles and script
# inline, no sibling assets — so copying the file alone is a complete page. That matters because a phone has no console
# to attach: perf-lab is how its real limits, its frame cost and any silently unlinked shader get read off the device,
# and gpu-probe is the fallback that needs nothing but a WebGL context. Everything else in tools/ pairs an .html with
# an .js and is a desktop tool. Both resolve assets relative to their own depth, which is preserved here.
os.makedirs('dist/tools', exist_ok=True)
for f in ['perf-lab.html', 'gpu-probe.html']: shutil.copy('tools/' + f, 'dist/tools/' + f)
print('dist ready:', len(seen), 'addon files + 2 diagnostics')
