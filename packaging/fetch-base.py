"""Fetch everything the Windows build needs from its public source, and verify it.

Usage: python packaging/fetch-base.py

Downloads the Node.js runtime and Electron at the versions pinned in packaging/pins.json,
refusing any file whose SHA-256 differs, and installs the MCP server with its dependencies
from npm exactly as pinned (with integrity hashes) in packaging/vendor/package-lock.json.
The result is laid out where the build and the tests expect it:

  build/downloads/                      Electron archive and its official checksum list
  build/base-payload/app/runtime/       node.exe
  build/base-payload/app/vendor/        node_modules of the MCP server

Install scripts are not run: the only dependency with one reports install statistics.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[1]
pins = json.loads((root / 'packaging/pins.json').read_text(encoding='utf-8'))
downloads = root / 'build/downloads'
base = root / 'build/base-payload/app'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url, dest, expected):
    """Download url to dest unless a verified copy is already there."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and sha256(dest) == expected:
        print(f'  verified {dest.relative_to(root)} (already present)')
        return
    part = dest.with_name(dest.name + '.part')
    print(f'  downloading {url}')
    with urllib.request.urlopen(url) as response, open(part, 'wb') as out:
        shutil.copyfileobj(response, out)
    got = sha256(part)
    if got != expected:
        part.unlink()
        sys.exit(f'Checksum mismatch for {url}: expected {expected}, got {got}. Nothing was installed.')
    part.replace(dest)
    print(f'  verified {dest.relative_to(root)}')


print('Electron')
electron = pins['electron']
zip_name = Path(electron['url']).name
fetch(electron['url'], downloads / zip_name, electron['sha256'])
# build-desktop.py checks the archive against Electron's own checksum list as well.
with urllib.request.urlopen(electron['checksums']) as response:
    checksums = response.read()
if not any(line.split()[0] == electron['sha256'] and line.split()[-1].lstrip('*') == zip_name
           for line in checksums.decode('ascii').splitlines() if line.strip()):
    sys.exit('Electron\'s published checksum list does not contain the pinned archive hash.')
(downloads / 'electron-SHASUMS256.txt').write_bytes(checksums)
print('  published checksum list agrees with the pin')

print('Node.js runtime')
node = pins['node']
fetch(node['url'], base / 'runtime/node.exe', node['sha256'])

print('MCP server and dependencies (npm ci, exactly as locked)')
vendor = base / 'vendor'
with tempfile.TemporaryDirectory(dir=root / 'build') as work:
    for name in ('package.json', 'package-lock.json'):
        shutil.copy2(root / 'packaging/vendor' / name, Path(work) / name)
    env = dict(os.environ, SCARF_ANALYTICS='false', PUPPETEER_SKIP_DOWNLOAD='true')
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=work, env=env, check=True)
    if vendor.exists():
        shutil.rmtree(vendor)
    vendor.mkdir(parents=True)
    shutil.move(str(Path(work) / 'node_modules'), str(vendor / 'node_modules'))
count = sum(1 for _ in (vendor / 'node_modules').rglob('*') if _.is_file())
print(f'  {count} files in {vendor.relative_to(root)}')
print('Done: build inputs fetched and verified.')
