import io

shell = io.open('build/_shell.html', encoding='utf-8').read().rstrip()
js = io.open('build/_engine.js', encoding='utf-8').read()
out = shell + chr(10) + js + chr(10) + '</body>' + chr(10) + '</html>' + chr(10)
io.open('index.html', 'w', encoding='utf-8', newline=chr(10)).write(out)
print('index.html', len(out), 'bytes')
