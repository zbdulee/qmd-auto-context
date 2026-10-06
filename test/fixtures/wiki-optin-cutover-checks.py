"""Recommended opt-in publishes settings last within the cutover lock."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

CODE = Path.cwd()
with tempfile.TemporaryDirectory(prefix='qmd-optin-cutover-') as temporary:
    base = Path(temporary).resolve()
    setup_cli = base / 'setup-cli-synthetic-platform.py'
    setup_cli.write_text('import sys\nsys.path.insert(0, ' + repr(str(CODE / 'core')) +
        ')\nimport install_update as setup\nsetup.supported_platform=lambda: True\n'
        'raise SystemExit(setup.main(sys.argv[1:]))\n')
    injection = base / 'injection'
    injection.mkdir()
    (injection / 'sitecustomize.py').write_text("""import os
from pathlib import Path
_original_write = os.write
_original_link = os.link

def guarded_write(fd, data):
    headers = {'SCHEMA.md': b'# Auto-context Wiki Schema',
               'index.md': b'# Auto-context Wiki Index',
               'log.md': b'# Auto-context Wiki Log'}
    selected = os.environ.get('QMD_FAIL_SCAFFOLD')
    if selected in headers and bytes(data).startswith(headers[selected]):
        _original_write(fd, data[:17])
        raise OSError('synthetic_partial_scaffold_write')
    return _original_write(fd, data)

def guarded_link(source, destination, *args, **kwargs):
    result = _original_link(source, destination, *args, **kwargs)
    if os.environ.get('QMD_RACE_SCHEMA') == str(destination):
        marker = Path(os.environ['QMD_RACE_MARKER'])
        marker.write_text(str(os.getpid()))
        release = Path(os.environ['QMD_RACE_RELEASE'])
        import time
        deadline = time.monotonic() + 10
        while not release.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        if not release.exists():
            raise TimeoutError('test_release_missing')
    return result

os.write = guarded_write
os.link = guarded_link
""")
    home = base / 'home'
    home.mkdir()
    clean_env = {**os.environ, 'HOME': str(home), 'PYTHONDONTWRITEBYTECODE': '1'}
    for key in ('PYTHONPATH', 'QMD_RACE_SCHEMA', 'QMD_RACE_MARKER',
                'QMD_RACE_RELEASE', 'QMD_FAIL_SCAFFOLD'):
        clean_env.pop(key, None)

    def project(name):
        root = base / name
        root.mkdir()
        docs = root / 'docs/current'
        docs.mkdir(parents=True)
        (docs / 'note.md').write_text('# Synthetic documentation\n')
        wiki = root / '.auto-context/wiki'
        wiki.mkdir(parents=True)
        (wiki / 'index.md').write_text('# Existing synthetic wiki\n')
        return root

    def paused_env(root, marker, release):
        return {**clean_env, 'PYTHONPATH': str(injection),
                'QMD_RACE_SCHEMA': str(root / '.auto-context/wiki/SCHEMA.md'),
                'QMD_RACE_MARKER': str(marker), 'QMD_RACE_RELEASE': str(release)}

    def start(root, env):
        return subprocess.Popen(['bash', 'core/update.sh', '--optin', '--recommended', str(root)],
            cwd=CODE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def wait_marker(marker, process):
        deadline = time.monotonic() + 10
        while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        assert marker.exists() and process.poll() is None

    root = project('paused')
    marker, release = base / 'scaffolded', base / 'release'
    optin = start(root, paused_env(root, marker, release))
    wait_marker(marker, optin)
    assert (root / '.auto-context/wiki/SCHEMA.md').is_file()
    assert not (root / '.auto-context/settings.json').exists()
    # The real cutover entrypoint must block until scaffold and settings finish.
    activate = subprocess.Popen([sys.executable, str(setup_cli), 'activate',
        '--project', str(root)], cwd=CODE, env=clean_env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(.3)
    assert activate.poll() is None, 'activate crossed unfinished opt-in'
    release.write_text('go')
    out, err = optin.communicate(timeout=12)
    assert optin.returncode == 0, (out, err)
    out, err = activate.communicate(timeout=12)
    assert activate.returncode == 0 and json.loads(out)['status'] == 'not_prepared', (out, err)
    assert (root / '.auto-context/settings.json').is_file()

    # A killed process leaves only partial scaffold; settings are not published.
    crashed = project('crashed')
    crash_marker, crash_release = base / 'crash-scaffolded', base / 'crash-release'
    crashing = start(crashed, paused_env(crashed, crash_marker, crash_release))
    wait_marker(crash_marker, crashing)
    assert not (crashed / '.auto-context/settings.json').exists()
    os.kill(int(crash_marker.read_text()), 9)
    crashing.communicate(timeout=10)
    assert not (crashed / '.auto-context/settings.json').exists()
    retried = subprocess.run(['bash', 'core/update.sh', '--optin', '--recommended', str(crashed)],
        cwd=CODE, env=clean_env, capture_output=True, text=True, timeout=20)
    assert retried.returncode == 0, (retried.stdout, retried.stderr)
    assert (crashed / '.auto-context/settings.json').is_file()
    assert (crashed / '.auto-context/wiki/SCHEMA.md').is_file()

    for filename, header in [('SCHEMA.md', '# Auto-context Wiki Schema'),
                             ('index.md', '# Auto-context Wiki Index'),
                             ('log.md', '# Auto-context Wiki Log')]:
        failed = project('failed-' + filename)
        if filename == 'index.md':
            (failed / '.auto-context/wiki/index.md').unlink()
        fail_env = {**clean_env, 'PYTHONPATH': str(injection),
                    'QMD_FAIL_SCAFFOLD': filename}
        result = subprocess.run(['bash', 'core/update.sh', '--optin', '--recommended', str(failed)],
            cwd=CODE, env=fail_env, capture_output=True, text=True, timeout=20)
        assert result.returncode != 0, (filename, result.stdout, result.stderr)
        assert not (failed / '.auto-context/settings.json').exists()
        assert not (failed / '.auto-context/wiki' / filename).exists()
        retried = subprocess.run(['bash', 'core/update.sh', '--optin', '--recommended', str(failed)],
            cwd=CODE, env=clean_env, capture_output=True, text=True, timeout=20)
        assert retried.returncode == 0, (filename, retried.stdout, retried.stderr)
        assert (failed / '.auto-context/settings.json').is_file()
        assert (failed / '.auto-context/wiki' / filename).read_text().startswith(header)

    # An interrupted older writer may already have put a fragment at the
    # destination. Preserve it and fail closed instead of publishing settings.
    legacy_partial = project('legacy-partial')
    fragment = b'# Auto-context W'
    schema = legacy_partial / '.auto-context/wiki/SCHEMA.md'
    schema.write_bytes(fragment)
    result = subprocess.run(['bash', 'core/update.sh', '--optin', '--recommended', str(legacy_partial)],
        cwd=CODE, env=clean_env, capture_output=True, text=True, timeout=20)
    assert result.returncode != 0 and 'incomplete wiki scaffold preserved' in result.stderr
    assert schema.read_bytes() == fragment
    assert not (legacy_partial / '.auto-context/settings.json').exists()

    # Compile can also create missing index/log headers. The same atomic
    # publisher must leave no destination after a partial temporary write.
    sys.path.insert(0, str(CODE / 'core'))
    import wiki_compile
    for filename, header in [('index.md', b'# Auto-context Wiki Index'),
                             ('log.md', b'# Auto-context Wiki Log')]:
        compile_root = project('compile-' + filename)
        wiki = compile_root / '.auto-context/wiki'
        destination = wiki / filename
        if destination.exists():
            destination.unlink()
        card = wiki / 'concepts/synthetic.md'
        def write_partial(fd, data):
            if bytes(data).startswith(header):
                os_write(fd, data[:17])
                raise OSError('synthetic_partial_compile_header')
            return os_write(fd, data)
        os_write = os.write
        with patch('os.write', side_effect=write_partial):
            try:
                if filename == 'index.md':
                    wiki_compile.update_index(wiki, card, 'Synthetic')
                else:
                    wiki_compile.append_log(wiki, 'created', card, 'Synthetic')
            except OSError as exc:
                assert str(exc) == 'synthetic_partial_compile_header'
            else:
                raise AssertionError('partial compile header write succeeded')
        assert not destination.exists()
        if filename == 'index.md':
            assert wiki_compile.update_index(wiki, card, 'Synthetic')
        else:
            wiki_compile.append_log(wiki, 'created', card, 'Synthetic')
        assert destination.read_bytes().startswith(header)
    print(json.dumps({'activateBlockedDuringOptin': True, 'failedOptinSettingsRemoved': True,
        'partialScaffoldRetryCompleted': True, 'crashBeforePublishRecovered': True,
        'legacyPartialScaffoldBlocked': True, 'compileHeaderRetryCompleted': True}))
