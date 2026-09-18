#!/usr/bin/env python3
"""Restricted SSH receiver for versioned production installers; no remote shell."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path('/var/www/vhosts/synora-ai.org/httpdocs/downloads/releases')
SUFFIX = {'mac': 'macos-arm64.zip', 'win': 'windows-x64.exe',
          'linux': 'linux-amd64.deb', 'web': 'web-linux-x64.tar.gz'}
VERSION = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
LIMIT = 2 * 1024 ** 3

def atomic(path, data):
    fd, temp = tempfile.mkstemp(prefix='.upload-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
            os.fchmod(f.fileno(), 0o644)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

def validate(record):
    if not isinstance(record, dict) or record.get('platform') not in SUFFIX:
        raise ValueError('Invalid platform')
    if not re.fullmatch(VERSION, record.get('version', '')):
        raise ValueError('Invalid version')
    if record.get('name') != f"Synora-{record['version']}-{SUFFIX[record['platform']]}":
        raise ValueError('Invalid filename')
    for key, pattern in [('sha256', r'[a-f0-9]{64}'), ('source', r'[a-f0-9]{40}')]:
        if not re.fullmatch(pattern, record.get(key, '')):
            raise ValueError('Invalid digest or source')
    if type(record.get('size')) is not int or not 0 < record['size'] <= LIMIT:
        raise ValueError('Invalid size')
    if not isinstance(record.get('notes'), str) or not 1 <= len(record['notes']) <= 20000:
        raise ValueError('Invalid notes')
    if not isinstance(record.get('description'), str) or not 1 <= len(record['description']) <= 1000:
        raise ValueError('Invalid description')
    if record.get('qualification') != 'passed' or not re.fullmatch(r'\d+', str(record.get('pipeline', ''))):
        raise ValueError('Missing qualification provenance')
    return record

def handle(root, command, source, destination):
    if command == 'read':
        destination.write((root / 'latest.json').read_bytes())
        return
    if command.startswith('upload '):
        args = command.split(' ')
        if len(args) != 5:
            raise ValueError('Invalid upload command')
        _, platform, version, size_text, digest = args
        if platform not in SUFFIX or not re.fullmatch(VERSION, version) or not re.fullmatch(r'[0-9]{1,10}', size_text) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid upload arguments')
        size = int(size_text)
        if not 0 < size <= LIMIT:
            raise ValueError('Oversized upload')
        directory = root / version
        directory.mkdir(exist_ok=True)
        target = directory / f'Synora-{version}-{SUFFIX[platform]}'
        fd, temporary = tempfile.mkstemp(prefix='.upload-', dir=directory)
        try:
            with os.fdopen(fd, 'wb') as f:
                remaining, checksum = size, hashlib.sha256()
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('Truncated upload')
                    checksum.update(chunk)
                    f.write(chunk)
                    remaining -= len(chunk)
                if source.read(1) or checksum.hexdigest() != digest:
                    raise ValueError('Upload digest or size mismatch')
                f.flush()
                os.fsync(f.fileno())
                os.fchmod(f.fileno(), 0o644)
            # link is atomic and cannot replace an already published package.
            try:
                os.link(temporary, target)
            except FileExistsError:
                if target.is_symlink() or target.stat().st_size != size or file_hash(target) != digest:
                    raise ValueError('Version already exists with different bytes')
            destination.write(b'UPLOAD_VERIFIED\n')
        finally:
            os.unlink(temporary)
        return
    if command != 'publish':
        raise ValueError('Unsupported operation')
    raw = source.read(32769)
    if len(raw) > 32768:
        raise ValueError('Oversized metadata')
    record = validate(json.loads(raw))
    version, platform = record['version'], record['platform']
    target = root / version / record['name']
    if target.is_symlink() or not target.is_file() or target.stat().st_size != record['size'] or file_hash(target) != record['sha256']:
        raise ValueError('Verified package required before publication')
    with (root / '.publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manifest = json.loads((root / 'latest.json').read_bytes())
        current = manifest['platforms'].get(platform)
        if current and tuple(map(int, current['version'].split('.'))) > tuple(map(int, version.split('.'))):
            raise ValueError('Downgrade refused')
        base = f'/downloads/releases/{version}/'
        record = {k: record[k] for k in ['platform', 'version', 'source', 'name', 'size', 'sha256', 'description', 'notes', 'qualification', 'pipeline']}
        record.update(url=base + record['name'], notesUrl=base + f'RELEASE-NOTES-{platform}.txt', checksumUrl=base + f'SHA256SUMS-{platform}.txt')
        stored = root / version / f'{platform}.json'
        if stored.exists():
            old = json.loads(stored.read_bytes())
            if any(old[k] != record[k] for k in ['sha256', 'source', 'size', 'name']):
                raise ValueError('Published version is immutable')
        atomic(root / version / f'RELEASE-NOTES-{platform}.txt', record['notes'].encode())
        atomic(root / version / f'SHA256SUMS-{platform}.txt', (record['sha256'] + '  ' + record['name'] + '\n').encode())
        atomic(stored, (json.dumps(record, indent=2) + '\n').encode())
        manifest['platforms'][platform] = record
        atomic(root / 'latest.json', (json.dumps(manifest, indent=2) + '\n').encode())
    destination.write(b'PUBLISHED\n')

def file_hash(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

if __name__ == '__main__':
    try:
        handle(ROOT, os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdin.buffer, sys.stdout.buffer)
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
