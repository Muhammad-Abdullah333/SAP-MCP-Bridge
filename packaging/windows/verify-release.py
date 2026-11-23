"""Check a built Windows release against this source tree, then write its checksums.

Usage: python packaging/windows/verify-release.py <output folder>

Run after packaging/windows/build.ps1. It confirms that the payload is intact, that every
file under src/ ships byte for byte, that the shipped policy engine and other patched vendor files are the patched ones,
that the app carries no scripts (antivirus heuristics weigh .vbs/.cmd/.ps1 launchers and
PowerShell helpers heavily), that its executable describes itself as this app, and that
the installer was built. It then writes the source archive and SHA256SUMS-<version>.txt
next to the installer.
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
engine = 'node_modules/abap-adt-mcp/dist/lib/policy.js'
patched = json.loads((root / 'packaging/vendor-patch/upstream.json').read_text(encoding='utf-8'))['files']
assert engine in patched, 'the policy engine is not listed in upstream.json'


def check(edition):
    """Payload checks shared by both editions, then what differs between them."""
    payload_path = root / f'build/{edition}-win32-x64-{version}/payload.zip'
    with zipfile.ZipFile(payload_path) as z:
        names = z.namelist()
        assert z.testzip() is None, f'{edition} payload CRC check failed'
        assert json.loads(z.read('app/package.json'))['version'] == version, 'payload version differs from package.json'
        assert z.read('app/assets/bridge.ico') == (root / 'assets/bridge.ico').read_bytes(), 'application icon differs'
        for p in (root / 'src').rglob('*'):
            if p.is_file():
                assert z.read('app/' + p.relative_to(root).as_posix()) == p.read_bytes(), f'{p} differs from the {edition} payload'
        # The engine that enforces the safety policy must be the patched one, byte for byte,
        # and so must every other patched vendor file.
        for rel in patched:
            assert z.read('app/vendor/' + rel) == (root / 'packaging/vendor-patch' / rel).read_bytes(), f'shipped {rel} differs from the patch'
        scripts = [n for n in names if n.lower().endswith(('.vbs', '.vbe', '.cmd', '.bat', '.ps1', '.psm1', '.wsf', '.hta'))]
        assert not scripts, f'the app must not carry scripts: {scripts[:10]}'
        assert 'app/runtime/node.exe' in names, 'node.exe missing'
        assert any(n.startswith('app/vendor/node_modules/@koromix/koffi-win32-x64/') and n.endswith('.node') for n in names), 'koffi binary missing'
        if edition == 'desktop':
            exe = z.read('app/desktop/SAP MCP Connection Manager.exe')
            # Version-resource strings are UTF-16. ("electron.exe" also occurs in Electron's own code,
            # so the check is on the publisher, which only the version resource carries.)
            assert 'SAP MCP Connection Manager.exe'.encode('utf-16-le') in exe, 'the app executable does not carry its own details (rcedit step)'
            assert 'GitHub, Inc.'.encode('utf-16-le') not in exe, 'the app executable still names Electron\'s publisher'
            locales = [n for n in names if n.startswith('app/desktop/locales/')]
            assert locales == ['app/desktop/locales/en-US.pak'], f'only the en-US interface language ships: {locales[:5]}'
            assert not any(n.endswith(('/dxcompiler.dll', '/dxil.dll')) for n in names), 'the WebGPU compiler must not ship'
        else:
            assert not any(n.startswith('app/desktop/') for n in names), 'the web edition must not carry Electron'
            assert 'app/src/web.js' in names, 'the web launcher is missing'
    print(f'PASS: {version} {edition} payload CRC, source parity under src/, the patched vendor files ({len(patched)}), no scripts' + (', own executable details, trimmed Electron.' if edition == 'desktop' else ', no Electron, web launcher.'))


editions = {'desktop': (f'SAP-MCP-Desktop-Bridge-{version}-Windows-Setup.exe', 50),
            'web': (f'SAP-MCP-Desktop-Bridge-{version}-Windows-Web-Setup.exe', 10)}
for edition, (setup_name, min_mb) in editions.items():
    check(edition)
    setup = out / setup_name
    assert setup.is_file() and setup.stat().st_size > min_mb * 1024 * 1024, f'{setup.name} is missing or too small'
    print(f'PASS: {setup.name} built ({setup.stat().st_size / 1048576:.1f} MB).')

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
