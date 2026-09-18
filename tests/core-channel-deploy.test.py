import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'scripts/core-channel-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synora-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / 'stable-v1.json'
        self.old = b'{"keyId":"test","payload":"old","signature":"test"}'
        self.file.write_bytes(self.old)

    def call(self, command, data=b''):
        output = io.BytesIO()
        deploy.handle(self.root, command, io.BytesIO(data), output)
        return output.getvalue()

    def test_read(self):
        self.assertEqual(self.call('read'), self.old)

    def test_v2_is_independent_and_cannot_replace_legacy(self):
        current = self.root / 'stable-v2.json'
        current.write_bytes(self.old)
        data = json.dumps(dict(keyId='test', payload='v2', signature='test')).encode()
        digest = hashlib.sha256(data).hexdigest()
        self.call('publish-v2 ' + hashlib.sha256(self.old).hexdigest() + ' ' + digest, data)
        self.assertEqual(self.call('read-v2'), data)
        self.assertEqual(self.call('read'), self.old)

    def test_v2_requires_explicit_provisioning(self):
        with self.assertRaises(ValueError):
            self.call('read-v2')

    def test_atomic_publish(self):
        data = json.dumps(dict(keyId='test', payload='new', signature='test')).encode()
        digest = hashlib.sha256(data).hexdigest()
        self.assertEqual(self.call('publish ' + hashlib.sha256(self.old).hexdigest() + ' ' + digest, data), (digest + '\n').encode())
        self.assertEqual(self.file.read_bytes(), data)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o644)
        self.assertFalse(list(self.root.glob('.catalog-*')))

    def test_commands_paths_and_shell_rejected(self):
        for command in ['id', 'read; id', 'read /etc/passwd', 'scp -t /tmp/x', 'internal-sftp', 'publish ../x']:
            with self.assertRaises(ValueError):
                self.call(command)
        self.assertEqual(self.file.read_bytes(), self.old)

    def test_bad_digest_and_stale_previous_rejected(self):
        for a, b in [('0' * 64, hashlib.sha256(self.old).hexdigest()), (hashlib.sha256(self.old).hexdigest(), '0' * 64)]:
            with self.assertRaises(ValueError):
                self.call('publish ' + a + ' ' + b, self.old)
        self.assertEqual(self.file.read_bytes(), self.old)

    def test_no_implicit_bootstrap_or_symlink(self):
        self.file.unlink()
        with self.assertRaises(ValueError):
            self.call('read')
        target = self.root / 'other'
        target.write_bytes(self.old)
        self.file.symlink_to(target)
        with self.assertRaises(ValueError):
            self.call('read')

    def test_oversize(self):
        with self.assertRaises(ValueError):
            self.call('publish ' + '0' * 64 + ' ' + '0' * 64, b'x' * (deploy.LIMIT + 1))


if __name__ == '__main__':
    unittest.main()
