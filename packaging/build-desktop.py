#!/usr/bin/env python3
"""Assemble reproducible desktop payloads from verified, pinned Electron and Node archives."""
import argparse,hashlib,json,os,plistlib,stat,subprocess,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--platform',choices=['win32-x64','darwin-arm64','darwin-x64'],required=True)
parser.add_argument('--output',required=True)
parser.add_argument('--base',required=True,help='build/base-payload as filled by packaging/fetch-base.py, or a pinned base package ZIP')
args=parser.parse_args();version=json.loads((root/'package.json').read_text())['version'];out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
platform=args.platform;electron=root/'build/downloads'/f'electron-v44.4.2-{platform}.zip'
checks=(root/'build/downloads/electron-SHASUMS256.txt').read_text();digest=hashlib.sha256(electron.read_bytes()).hexdigest()
assert any(line.split()[0]==digest and line.split()[-1].lstrip('*')==electron.name for line in checks.splitlines()),'Electron checksum mismatch'
work=root/'build'/f'desktop-{platform}-{version}';work.mkdir(parents=True,exist_ok=True)
# Bridge patches a small number of vendored abap-adt-mcp files (the policy engine).
# Each patch records the digest of the upstream file it was written against; if the base
# package ever ships a different one the build stops rather than patching blindly.
patch_dir=root/'packaging/vendor-patch'
patches=json.loads((patch_dir/'upstream.json').read_text())['files'] if (patch_dir/'upstream.json').is_file() else {}
applied=set()
def vendor_bytes(name,prefix,data):
 rel=name[len(prefix):] if name.startswith(prefix) else None
 if not rel or rel not in patches: return data
 want=patches[rel]['upstreamSha256'];got=hashlib.sha256(data).hexdigest()
 assert got==want,f'vendor patch base changed for {rel}: expected {want}, found {got}. Re-derive the patch against the new upstream file.'
 applied.add(rel);return (patch_dir/rel).read_bytes()
def put(z,name,data,mode=0o644):
 info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=(stat.S_IFREG|mode)<<16;z.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
def branded_exe(data):
 # electron.exe describes itself as "Electron" by "GitHub, Inc.", original file name
 # electron.exe. A program whose details do not match its own name is what antivirus
 # heuristics call masquerading, so the copy shipped gets this app's details and icon.
 rcedit=root/'build/tools/rcedit-x64.exe'
 assert rcedit.is_file(),f'{rcedit} is missing; run packaging/fetch-base.py first'
 # CompanyName is the publisher Windows shows; it matches the installer (installer.iss).
 details={'CompanyName':'Muhammad Abdullah','FileDescription':'SAP MCP Connection Manager','ProductName':'SAP MCP Desktop Bridge','InternalName':'SAP MCP Connection Manager','OriginalFilename':'SAP MCP Connection Manager.exe','LegalCopyright':'Copyright (c) 2026 SAP MCP Desktop Bridge contributors. MIT License.'}
 with tempfile.TemporaryDirectory(dir=root/'build') as temp:
  exe=Path(temp)/'app.exe';exe.write_bytes(data)
  command=[str(rcedit),str(exe),'--set-file-version',version,'--set-product-version',version,'--set-icon',str(root/'assets/bridge.ico')]
  for key,value in details.items():command+=['--set-version-string',key,value]
  subprocess.run(command,check=True)
  return exe.read_bytes()
def source(z,prefix):
 for p in sorted((root/'src').rglob('*')):
  if p.is_file():put(z,prefix+p.relative_to(root).as_posix(),p.read_bytes())
 for name in ['package.json','LICENSE','THIRD-PARTY-NOTICES.txt']:
  put(z,prefix+name,(root/name).read_bytes())
 put(z,prefix+'LICENSES/Node-LICENSE',(root/'assets/Node-LICENSE').read_bytes())
 for name in ['bridge.png','bridge.ico','bridge.icns','bridge.svg']:put(z,prefix+'assets/'+name,(root/'assets'/name).read_bytes())
if platform=='win32-x64':
 payload=work/'payload.zip'
 base=Path(args.base)
 # The runtime and the MCP server come either from a folder filled by
 # packaging/fetch-base.py (public sources, verified) or from a pinned base package ZIP.
 if base.is_dir():
  # node_modules/.bin holds npm's .cmd/.ps1 command shims; the app never runs them.
  base_files=[(p.relative_to(base).as_posix(),p) for d in ('app/runtime','app/vendor') for p in sorted((base/d).rglob('*')) if p.is_file() and '.bin' not in p.relative_to(base).parts]
  assert any(n=='app/runtime/node.exe' for n,_ in base_files),f'no app/runtime/node.exe under {base}; run packaging/fetch-base.py first'
 else:
  with zipfile.ZipFile(base) as oldkit:
   oldpayload=work/'base-payload.zip';oldpayload.write_bytes(oldkit.read('payload.zip'))
 with zipfile.ZipFile(payload,'w') as z,zipfile.ZipFile(electron) as desktop:
  if base.is_dir():
   # Sorted, with fixed timestamps (put), so the same inputs always give the same payload.
   for name,p in base_files: put(z,name,vendor_bytes(name,'app/vendor/',p.read_bytes()),0o755 if name.endswith('.exe') else 0o644)
  else:
   with zipfile.ZipFile(oldpayload) as old:
    for info in old.infolist():
     if info.filename.startswith(('app/vendor/','app/runtime/')) and '/node_modules/.bin/' not in info.filename: z.writestr(info,vendor_bytes(info.filename,'app/vendor/',old.read(info.filename)),compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
  source(z,'app/')
  for info in desktop.infolist():
   if info.is_dir() or info.filename=='resources/default_app.asar':continue
   if info.filename=='electron.exe':put(z,'app/desktop/SAP MCP Connection Manager.exe',branded_exe(desktop.read(info.filename)),0o755)
   else:put(z,'app/desktop/'+info.filename,desktop.read(info.filename))
  put(z,'app/desktop/resources/app/package.json',json.dumps({'name':'sap-mcp-connection-manager','version':version,'main':'index.js'}).encode())
  put(z,'app/desktop/resources/app/index.js',b"require('../../../src/desktop.js');\n")
  # Nothing else: the installer (packaging/windows/installer.iss) adds the Start menu
  # shortcut and a standard uninstaller, so the app carries no launcher scripts.
  names=set(z.namelist())
 assert applied==set(patches),f'vendor patch targets missing from the base payload: {set(patches)-applied}'
 # Saved passwords are encrypted through koffi (src/dpapi.js); a base without it cannot work.
 assert 'app/vendor/node_modules/koffi/package.json' in names and any(n.startswith('app/vendor/node_modules/@koromix/koffi-win32-x64/') and n.endswith('.node') for n in names),'koffi is missing from the vendored modules; run packaging/fetch-base.py and build from build/base-payload'
 print(payload,flush=True)
else:
 arch=platform.split('-')[1];package=out/f'SAP-MCP-Desktop-Bridge-{version}-macOS-{arch}.zip';prefix='SAP MCP Desktop Bridge.app/Contents/'
 with zipfile.ZipFile(package,'w') as z,zipfile.ZipFile(args.base) as old,zipfile.ZipFile(electron) as desktop:
  for info in desktop.infolist():
   if not info.filename.startswith('Electron.app/') or info.is_dir() or '/_CodeSignature/' in info.filename or info.filename.endswith('/CodeResources'):continue
   if info.filename=='Electron.app/Contents/Resources/default_app.asar':continue
   data=desktop.read(info.filename)
   if info.filename=='Electron.app/Contents/Info.plist':
    plist=plistlib.loads(data);plist.update(CFBundleName='SAP MCP Connection Manager',CFBundleDisplayName='SAP MCP Connection Manager',CFBundleIdentifier='com.sap-mcp.desktop-bridge',CFBundleVersion=version,CFBundleShortVersionString=version,CFBundleIconFile='bridge.icns')
    data=plistlib.dumps(plist)
   info.filename=info.filename.replace('Electron.app/','SAP MCP Desktop Bridge.app/',1)
   z.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
  for info in old.infolist():
   if info.filename.startswith((prefix+'Resources/runtime/',prefix+'Resources/app/vendor/')):z.writestr(info,vendor_bytes(info.filename,prefix+'Resources/app/vendor/',old.read(info.filename)),compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
  source(z,prefix+'Resources/app/')
  put(z,prefix+'Resources/bridge.icns',(root/'assets/bridge.icns').read_bytes())
  for license_name in ['LICENSE','LICENSES.chromium.html']:
   if license_name in desktop.namelist():put(z,prefix+'Resources/app/LICENSES/Electron-'+license_name,desktop.read(license_name))
  put(z,'Install.command',(root/'packaging/macos/Install.command').read_bytes(),0o755)
  put(z,prefix+'Resources/Rollback.command',(root/'packaging/macos/Rollback.command').read_bytes(),0o755)
  put(z,'README FIRST.txt',b'Community build. Extract, run Install.command, then open SAP MCP Connection Manager from Applications. Installation does not open the app. A Mac is required to validate installation, Keychain access and signing.\n')
  assert applied==set(patches),f'vendor patch targets missing from the base payload: {set(patches)-applied}'
 print(package,flush=True)
