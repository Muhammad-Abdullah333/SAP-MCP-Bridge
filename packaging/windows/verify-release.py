"""Check a built Windows release against this source tree, then write its checksums.

Usage: python packaging/windows/verify-release.py <output folder>

Run after packaging/windows/build.ps1. It confirms that the payload is intact, that every
file under src/ ships byte for byte, that the shipped policy engine is the patched one,
and that the distribution ZIP carries exactly that payload. It then writes the source
archive and SHA256SUMS-<version>.txt next to the installer.
"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
if len(sys.argv) != 2:
    sys.exit(__doc__)
out = Path(sys.argv[1]).resolve()
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
payload_path = root / f'build/desktop-win32-x64-{version}/payload.zip'
engine = 'node_modules/abap-adt-mcp/dist/lib/policy.js'

with zipfile.ZipFile(payload_path) as z:
    assert z.testzip() is None, 'payload CRC check failed'
    assert json.loads(z.read('app/package.json'))['version'] == version, 'payload version differs from package.json'
    assert z.read('app/assets/bridge.ico') == (root / 'assets/bridge.ico').read_bytes(), 'application icon differs'
    for p in (root / 'src').rglob('*'):
        if p.is_file():
            assert z.read('app/' + p.relative_to(root).as_posix()) == p.read_bytes(), f'{p} differs from the payload'
    # The engine that enforces the safety policy must be the patched one, byte for byte.
    assert z.read('app/vendor/' + engine) == (root / 'packaging/vendor-patch' / engine).read_bytes(), 'shipped policy engine differs from the patch'
print(f'PASS: {version} payload CRC, source parity under src/, and the patched policy engine.')

with zipfile.ZipFile(out / f'SAP-MCP-Desktop-Bridge-{version}-Windows.zip') as z:
    assert z.testzip() is None, 'distribution ZIP CRC check failed'
    assert z.read('payload.zip') == payload_path.read_bytes(), 'distribution ZIP carries a different payload'
print('PASS: distribution ZIP CRC and embedded payload.')

sources = [p for folder in ['src', 'test', 'packaging'] for p in (root / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
sources += list((root / 'assets').glob('bridge.*'))
sources += [root / name for name in ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'assets/Node-LICENSE']]
checksums = root / 'build/downloads/electron-SHASUMS256.txt'
if checksums.exists():
    sources.append(checksums)
with zipfile.ZipFile(out / f'SAP-MCP-Desktop-Bridge-{version}-source.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sources:
        z.write(p, p.relative_to(root).as_posix())

# LF line endings, so 'sha256sum -c' reads the manifest as written.
with (out / f'SHA256SUMS-{version}.txt').open('w', encoding='ascii', newline='\n') as f:
    for p in sorted(out.glob(f'*{version}*')):
        if p.suffix in ('.exe', '.zip'):
            f.write(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n')
print(f'Source archive and SHA256SUMS-{version}.txt written to {out}.')
