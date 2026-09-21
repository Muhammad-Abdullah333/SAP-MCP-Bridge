#!/usr/bin/env python3
"""Create a macOS-friendly ZIP with Unix executable bits preserved."""
import os
import stat
import sys
import zipfile

source, destination = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as archive:
    for root, directories, files in os.walk(source):
        directories.sort(); files.sort()
        relative_root = os.path.relpath(root, source)
        for name in files:
            full = os.path.join(root, name)
            relative = os.path.normpath(os.path.join(relative_root, name)).replace("\\", "/")
            info = zipfile.ZipInfo.from_file(full, relative)
            executable = name in {"Install.command", "SAP MCP Desktop Bridge", "node"}
            mode = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            info.external_attr = mode
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as handle:
                archive.writestr(info, handle.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
