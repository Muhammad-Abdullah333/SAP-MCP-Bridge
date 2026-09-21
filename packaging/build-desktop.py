#!/usr/bin/env python3
"""Assemble reproducible desktop payloads from verified, pinned Electron and Node archives."""
import argparse,hashlib,json,os,plistlib,stat,zipfile
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
  base_files=[(p.relative_to(base).as_posix(),p) for d in ('app/runtime','app/vendor') for p in sorted((base/d).rglob('*')) if p.is_file()]
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
     if info.filename.startswith(('app/vendor/','app/runtime/')): z.writestr(info,vendor_bytes(info.filename,'app/vendor/',old.read(info.filename)),compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
  source(z,'app/')
  for info in desktop.infolist():
   if info.is_dir() or info.filename=='resources/default_app.asar':continue
   name='app/desktop/'+('SAP MCP Connection Manager.exe' if info.filename=='electron.exe' else info.filename)
   put(z,name,desktop.read(info.filename))
  put(z,'app/desktop/resources/app/package.json',json.dumps({'name':'sap-mcp-connection-manager','version':version,'main':'index.js'}).encode())
  put(z,'app/desktop/resources/app/index.js',b"require('../../../src/desktop.js');\n")
  put(z,'app/SAP MCP Desktop Bridge.cmd',b'@echo off\r\nstart "" "%~dp0desktop\\SAP MCP Connection Manager.exe"\r\n')
  put(z,'app/Launch Manager.vbs',b'Set shell = CreateObject("WScript.Shell")\r\nSet fso = CreateObject("Scripting.FileSystemObject")\r\nroot = fso.GetParentFolderName(WScript.ScriptFullName)\r\nshell.Run Chr(34) & root & "\\desktop\\SAP MCP Connection Manager.exe" & Chr(34), 0, False\r\n')
  for name in ['Uninstall.ps1','Rollback.ps1']:put(z,'app/'+name,(root/'packaging/windows'/name).read_bytes())
 assert applied==set(patches),f'vendor patch targets missing from the base payload: {set(patches)-applied}'
 package=out/f'SAP-MCP-Desktop-Bridge-{version}-Windows.zip'
 with zipfile.ZipFile(package,'w') as z:
  z.write(payload,'payload.zip',compress_type=zipfile.ZIP_STORED)
  for name in ['Setup.cmd','Install.ps1']:put(z,name,(root/'packaging/windows'/name).read_bytes())
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
