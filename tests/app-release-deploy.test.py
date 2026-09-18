import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'scripts/app-release-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'latest.json').write_text('{"schema":1,"platforms":{}}')
    def call(self, command, data=b''):
        out = io.BytesIO()
        deploy.handle(self.root, command, io.BytesIO(data), out)
        return out.getvalue()
    def record(self, platform='linux', version='1.0.0', data=b'package'):
        return dict(platform=platform,version=version,name=f'Synora-{version}-{deploy.SUFFIX[platform]}',source='a'*40,
            sha256=hashlib.sha256(data).hexdigest(),size=len(data),notes='Release notes',description='Real application',qualification='passed',pipeline='123')
    def upload(self,r,data=b'package'):
        return self.call(f"upload {r['platform']} {r['version']} {r['size']} {r['sha256']}",data)
    def publish(self,r):
        return self.call('publish',json.dumps(r).encode())
    def test_independent_platforms_and_idempotent_retry(self):
        for p in ['linux','mac','win','web']:
            r=self.record(p);self.upload(r);self.publish(r);self.upload(r);self.publish(r)
        manifest=json.loads(self.call('read'))
        self.assertEqual(set(manifest['platforms']),set(deploy.SUFFIX))
        self.assertEqual(manifest['platforms']['mac']['url'],'/downloads/releases/1.0.0/Synora-1.0.0-macos-arm64.zip')
    def test_corrupt_short_long_uploads_do_not_publish(self):
        r=self.record()
        for data in [b'wrongxx',b'pack',b'packageextra']:
            with self.assertRaises(ValueError):self.upload(r,data)
        self.assertEqual(json.loads(self.call('read'))['platforms'],{})
    def test_existing_version_cannot_be_overwritten(self):
        r=self.record();self.upload(r);self.publish(r)
        with self.assertRaises(ValueError):self.upload(self.record(data=b'changed'),b'changed')
    def test_no_metadata_without_verified_package(self):
        with self.assertRaises(ValueError):self.publish(self.record())
    def test_old_release_cannot_downgrade_current(self):
        r=self.record(version='2.0.0');self.upload(r);self.publish(r)
        r=self.record();self.upload(r)
        with self.assertRaises(ValueError):self.publish(r)
    def test_paths_shell_and_oversize_rejected(self):
        for cmd in ['sh','upload linux ../../evil 7 '+'a'*64,'upload fake 1.0.0 7 '+'a'*64,'upload linux 1.0.0 9999999999 '+'a'*64]:
            with self.assertRaises(ValueError):self.call(cmd)
        with self.assertRaises(ValueError):self.call('publish',b'x'*32769)
    def test_failed_gate_rejected(self):
        r=self.record();self.upload(r);r['qualification']='failed'
        with self.assertRaises(ValueError):self.publish(r)

if __name__=='__main__':unittest.main()
