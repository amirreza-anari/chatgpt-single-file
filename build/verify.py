# Verifier for the single-file clone: markup/JS consistency, CSS brace balance,
# JS syntax, and single-file purity. Run: python build/verify.py
import io, os, re, subprocess, sys, hashlib

root = os.path.dirname(os.path.abspath(__file__))
proj = os.path.dirname(root)
sh = io.open(os.path.join(root, '_shell.html'), encoding='utf-8').read()
js = io.open(os.path.join(root, '_engine.js'), encoding='utf-8').read()
bad = []

# --- 1. nothing left that only said "not implemented" -------------------------
dead = ['data-stub', 'profileBtn', 'profilePop', 'footTitle', 'footCopy', 'footAction', 'modelLabel',
        'themeBtn', 'noKeyBtn', 'segMode', 'seg-item', 'promoClose', 'moreBtn', 'searchTabs', 'srch-tab',
        'paneStub', 'stubNote', 'settingsBtn', "part of this build", 'not implemented']
for d in dead:
    for name, txt in (('_shell.html', sh), ('_engine.js', js)):
        if d in txt:
            bad.append('leftover %r in %s' % (d, name))

# --- 2. every id the JS reaches for must exist (or be built at runtime) ------
runtime = {'composerHold', 'mpManage'}
ids = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', js)) | set(re.findall(r'getElementById\("([A-Za-z0-9_-]+)"\)', js))
have = set(re.findall(r'id="([A-Za-z0-9_-]+)"', sh))
for i in sorted(ids - have - runtime):
    bad.append('JS references #%s, absent from markup' % i)

# --- 3. CSS braces balance inside <style> -----------------------------------
css = ''.join(re.findall(r'<style>(.*?)</style>', sh, re.S))
if css.count('{') != css.count('}'):
    bad.append('CSS braces unbalanced: %d { vs %d }' % (css.count('{'), css.count('}')))

# --- 4. JS syntax -----------------------------------------------------------
body = re.sub(r'^\s*<script[^>]*>', '', js)
body = re.sub(r'</script>\s*$', '', body)
tmp = os.path.join(os.environ.get('TMPDIR', root), 'engine_check.js')
io.open(tmp, 'w', encoding='utf-8', newline='\n').write(body)
p = subprocess.run(['node', '--check', tmp.replace('\\', '/')], capture_output=True, text=True)
if p.returncode:
    bad.append('JS syntax: ' + (p.stderr or '').strip()[:400])
os.remove(tmp)

# --- 5. rebuild + purity ----------------------------------------------------
subprocess.run([sys.executable, os.path.join(root, 'rebuild.py')], check=True, cwd=proj)
out = os.path.join(proj, 'index.html')
idx = io.open(out, encoding='utf-8').read()
for pat, why in ((r'(?:src|href)\s*=\s*["\']https?:', 'external asset ref'),
                 (r'@import', '@import'),
                 (r'(?<![\w-])url\(\s*(?!["\']?data:)', 'external url('),
                 (r'<script[^>]+src=', 'script src')):
    hits = re.findall(pat, idx, re.I)
    if hits:
        bad.append('%s x%d in index.html' % (why, len(hits)))

print('index.html %d bytes  md5 %s' % (len(idx.encode()), hashlib.md5(idx.encode()).hexdigest()))
print('icons inlined: %d symbols' % len(re.findall(r'<symbol id="ri-', idx)))
if bad:
    print('\n'.join('FAIL ' + b for b in bad))
    sys.exit(1)
print('OK  no stubs, ids resolve, CSS balanced, JS parses, single file, no external assets')
