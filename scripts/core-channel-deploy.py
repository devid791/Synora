#!/usr/bin/env python3
"""Root-owned forced SSH command; no shell, paths, SCP or forwarding."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

LIMIT = 2 * 1024 * 1024
ROOT = Path('/var/lib/synora-core-publisher/channel')


def handle(root, command, source, destination):
    current = root / 'stable-v1.json'
    if current.is_symlink() or not current.is_file():
        raise ValueError('Catalog must be provisioned first')
    if command == 'read':
        data = current.read_bytes()
        if len(data) > LIMIT:
            raise ValueError('Oversized catalog')
        destination.write(data)
        return
    match = re.fullmatch(r'publish ([a-f0-9]{64}) ([a-f0-9]{64})', command)
    if not match:
        raise ValueError('Unsupported deployment operation')
    data = source.read(LIMIT + 1)
    if len(data) > LIMIT or hashlib.sha256(data).hexdigest() != match[2]:
        raise ValueError('Invalid upload size or digest')
    envelope = json.loads(data)
    if not isinstance(envelope, dict) or set(envelope) != {'keyId', 'payload', 'signature'}:
        raise ValueError('Expected a signed catalog envelope')
    # The protected signer AND clients verify signatures. Hosting is not trust.
    with (root / '.publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if current.is_symlink() or hashlib.sha256(current.read_bytes()).hexdigest() != match[1]:
            raise ValueError('Catalog changed since download')
        fd, staged = tempfile.mkstemp(prefix='.catalog-', dir=root)
        try:
            with os.fdopen(fd, 'wb') as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
                os.fchmod(file.fileno(), 0o644)
            os.replace(staged, current)
            directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(staged):
                os.unlink(staged)
    destination.write((match[2] + '\n').encode())


if __name__ == '__main__':
    try:
        handle(ROOT, os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdin.buffer, sys.stdout.buffer)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
