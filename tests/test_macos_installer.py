#!/usr/bin/env python3
"""Exercise the generated macOS shell flow using a private mock launchd session."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

TEMPLATE = Path(__file__).resolve().parents[1] / 'client-scripts/macos-installer.sh'
TOKEN = '9999999999999999'
PRESET = {'host': 'gateway.example', 'port': 27183, 'ca': 'test certificate\n'}

TOOLS = r'''#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import plistlib
import sys
from urllib.parse import parse_qs, urlsplit

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
fixtures = Path(os.environ['FIXTURES'])
app = Path.home() / 'Library/Application Support/fastp2p'
plist = Path.home() / 'Library/LaunchAgents/top.fastp2p.plist'
loaded = fixtures / 'loaded'

if tool == 'id':
    print('501')
elif tool == 'uname':
    print('Darwin' if args == ['-s'] else os.environ['CPU'])
elif tool == 'sysctl':
    print(os.environ['APPLE_SILICON'])
elif tool == 'sw_vers':
    print('13.6.0')
elif tool == 'plutil':
    assert args[:5] == ['-extract', 'ProgramArguments.3', 'raw', '-o', '-']
    print(plistlib.loads(plist.read_bytes())['ProgramArguments'][3])
elif tool == 'launchctl':
    if args == ['print', 'gui/501']:
        sys.exit(0)
    if args == ['print', 'gui/501/top.fastp2p']:
        sys.exit(0 if loaded.exists() else 1)
    if args == ['bootout', 'gui/501/top.fastp2p']:
        loaded.unlink()
    elif args == ['bootstrap', 'gui/501', str(plist)]:
        assert plist.is_file()
        loaded.touch()
    else:
        sys.exit(2)
elif tool == 'curl':
    cfg = Path(args[args.index('--config')+1])
    assert cfg.stat().st_mode & 0o777 == 0o600
    assert 'Authorization: FastP2P ' + os.environ['TEST_KEY'] in cfg.read_text()
    assert 'cacert = "' in cfg.read_text()
    assert os.environ['TEST_KEY'] not in ' '.join(args)
    assert args[0] == '-q' and args[args.index('--proto')+1] == '=https'
    url = urlsplit(args[-1])
    assert url.scheme == 'https' and url.netloc == 'gateway.example:27183'
    assert url.path == '/api/v1/update/download'
    query = parse_qs(url.query)
    assert query['version'] == ['9.9.9'] and 'token' not in query
    platform = query['platform'][0]
    (fixtures / 'downloaded').write_text(platform)
    data = (fixtures / platform).read_bytes()
    if os.environ.get('FAILURE') == 'checksum':
        data = data[:-1] + bytes((data[-1] ^ 1,))
    Path(args[args.index('--output')+1]).write_bytes(data)
elif tool == 'shasum':
    assert args == ['-a', '256', '-c', '-']
    digest, filename = sys.stdin.readline().rstrip('\n').split('  ', 1)
    sys.exit(0 if hashlib.sha256(Path(filename).read_bytes()).hexdigest() == digest else 1)
elif tool == 'fastp2p':
    if args == ['--version']:
        print('fastp2p 9.9.9 ABI 1')
        sys.exit(0)
    assert args[0] == 'install' and os.environ['TEST_KEY'] not in ' '.join(args)
    key_file = Path(args[args.index('--token-file')+1])
    assert key_file.stat().st_mode & 0o777 == 0o600
    assert key_file.read_text() == os.environ['TEST_KEY']
    assert json.loads(Path(os.environ['FASTP2P_BOOTSTRAP_FILE']).read_text()) == json.loads(os.environ['TEST_PRESET'])
    profile = Path(args[args.index('--config')+1])
    config = json.loads(profile.read_text()) if profile.exists() else {'id': 'new-node'}
    config['installed'] = True
    profile.write_text(json.dumps(config))
    (app / 'fastp2p').write_text('new-binary')
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_bytes(plistlib.dumps({'ProgramArguments': [str(app / 'fastp2p'), 'run', '--config', str(profile)]}))
    loaded.unlink(missing_ok=True)
    if os.environ.get('FAILURE') == 'launch':
        sys.exit(1)
    loaded.touch()
else:
    sys.exit(2)
'''


class MacInstaller(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='fastp2p-macos-test.')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.home = self.root / 'home with spaces'
        self.app = self.home / 'Library/Application Support/fastp2p'
        self.plist = self.home / 'Library/LaunchAgents/top.fastp2p.plist'
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        mock = self.tools / 'mock'
        mock.write_text(TOOLS)
        mock.chmod(0o755)
        for name in ('id', 'uname', 'sw_vers', 'sysctl', 'plutil', 'launchctl', 'curl', 'shasum'):
            (self.tools / name).symlink_to(mock)
        self.env = dict(os.environ, HOME=str(self.home), FIXTURES=str(self.root),
                        TEST_KEY=TOKEN, TEST_PRESET=json.dumps(PRESET),
                        PATH=str(self.tools)+os.pathsep+os.environ['PATH'],
                        CPU='x86_64', APPLE_SILICON='0')

    def run_installer(self, arches=('arm64', 'x86_64'), ticket=False, **env):
        manifest = ["gateway_url='https://gateway.example:27183'", 'download_ca=1', 'case "$arch" in']
        for arch in arches:
            platform = 'macos-' + arch
            payload = (TOOLS + '\n# ' + arch + '\n').encode()
            (self.root / platform).write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            manifest.append(f"{arch}) package_platform='{platform}'; expected_version='9.9.9'; "
                            f"expected_sha='{digest}'; expected_size={len(payload)} ;;")
        manifest.extend([
            '*) fail "unsupported architecture" ;;', 'esac',
            """cat > "$work/gateway-ca.pem" <<'CA_EOF'""", PRESET['ca'], 'CA_EOF',
            """cat > "$work/gateway.json" <<'JSON_EOF'""", json.dumps(PRESET), 'JSON_EOF',
        ])
        script = self.root / ('install.sh' if ticket else 'fastp2p-macos-' + TOKEN + '.sh')
        body = TEMPLATE.read_text(encoding='utf-8').replace('@@FASTP2P_DOWNLOAD@@', '\n'.join(manifest))
        if ticket:
            body = body.replace("token=''\n", f"token='{TOKEN}'\n", 1)
        script.write_text(body, encoding='utf-8')
        return subprocess.run(['/bin/sh', str(script)], env=dict(self.env, **env),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)

    def seed_install(self):
        self.app.mkdir(parents=True)
        binary = self.app / 'fastp2p'
        profile = self.home / 'custom profile.json'
        self.plist.parent.mkdir()
        binary.write_text('original-binary')
        profile.write_text('{"id":"old-node","settings":[1,2]}')
        self.plist.write_bytes(plistlib.dumps({'ProgramArguments': [str(binary), 'run', '--config', str(profile)]}))
        (self.root / 'loaded').touch()
        return binary, profile, self.plist

    def test_intel_and_login_startup(self):
        result = self.run_installer(ticket=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'downloaded').read_text(), 'macos-x86_64')
        self.assertTrue((self.root / 'loaded').exists())

    def test_rosetta_reinstall_preserves_custom_profile(self):
        _, profile, _ = self.seed_install()
        result = self.run_installer(APPLE_SILICON='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'downloaded').read_text(), 'macos-arm64')
        self.assertEqual(json.loads(profile.read_text()), {'id': 'old-node', 'settings': [1, 2], 'installed': True})
        self.assertFalse((self.app / 'client.json').exists())

    def test_bad_hash_and_missing_arch_do_not_change_install(self):
        paths = self.seed_install()
        original = [path.read_bytes() for path in paths]
        for result in (self.run_installer(('arm64',)), self.run_installer(FAILURE='checksum')):
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual([path.read_bytes() for path in paths], original)
            self.assertTrue((self.root / 'loaded').exists())
            self.assertFalse((self.app / '.install.lock').exists())

    def test_rollback_after_launch_failure(self):
        paths = self.seed_install()
        original = [path.read_bytes() for path in paths]
        result = self.run_installer(FAILURE='launch')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([path.read_bytes() for path in paths], original)
        self.assertTrue((self.root / 'loaded').exists())


if __name__ == '__main__':
    unittest.main()
