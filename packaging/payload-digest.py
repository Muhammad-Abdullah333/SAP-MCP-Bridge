"""Print a fingerprint of what an app payload contains, independent of how it was compressed.

Usage: python packaging/payload-digest.py <payload.zip>

The payload ZIP is written in a fixed order with fixed timestamps, but the compressed
bytes still depend on the zlib build that compressed them (CPython 3.14 on Windows uses
zlib-ng, earlier versions stock zlib), so two correct builds can differ byte for byte.
This fingerprint covers every entry's name and its uncompressed contents, so it is the
same for the same files however they were packed. The Windows build publishes it on
every run; compare it with your own build of the same commit.
"""
import hashlib
import sys
import zipfile


def content_digest(path):
    digest = hashlib.sha256()
    with zipfile.ZipFile(path) as z:
        for name in sorted(i.filename for i in z.infolist() if not i.is_dir()):
            digest.update(name.encode('utf-8') + b'\0' + hashlib.sha256(z.read(name)).digest())
    return digest.hexdigest()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(content_digest(sys.argv[1]))
