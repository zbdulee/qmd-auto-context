"""Selected DB lexical gate must never consult a different daemon index."""
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, 'core')
import recall

with tempfile.TemporaryDirectory(prefix='qmd-lex-route-') as temporary:
    root = Path(temporary)
    qmd = root / 'qmd'
    qmd.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
Path(os.environ['QMD_LEX_CALLS']).open('a').write(json.dumps({
    'argv':sys.argv[1:], 'index':os.environ.get('INDEX_PATH'),
    'config':os.environ.get('QMD_CONFIG_DIR'),
    'cache':os.environ.get('XDG_CACHE_HOME')})+'\\n')
if os.environ.get('QMD_LEX_FAIL')=='1':sys.exit(7)
print(json.dumps([{'file':'qmd://synthetic-wiki/card.md','score':1}]
    if os.environ.get('INDEX_PATH')==os.environ['QMD_LEX_EXPECTED'] else []))
''')
    qmd.chmod(0o700)
    selected = {'INDEX_PATH': str(root / 'selected.sqlite'),
                'QMD_CONFIG_DIR': str(root / 'selected-config'),
                'XDG_CACHE_HOME': str(root / 'selected-cache')}
    os.environ.update(QMD_BIN=str(qmd), QMD_LEX_CALLS=str(root / 'calls.jsonl'),
                      QMD_LEX_EXPECTED=selected['INDEX_PATH'])
    searches = [{'type': 'lex', 'query': 'April cobalt pears'}]
    original = recall.urllib.request.urlopen
    daemon_calls = []
    class EmptyGlobalDb:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self): return b'{"results": []}'
    def empty_global_db(*args, **_kwargs):
        daemon_calls.append(args[0].full_url)
        return EmptyGlobalDb()
    recall.urllib.request.urlopen = empty_global_db
    try:
        assert recall.run_lex_probe('http://localhost:1', ['synthetic-wiki'],
                                    searches, 1.0) == 0
        assert len(daemon_calls) == 1
        assert recall.run_lex_probe('http://localhost:1', ['synthetic-wiki'],
                                    searches, 1.0, project_index=selected) == 1
        assert len(daemon_calls) == 1
        os.environ['QMD_LEX_FAIL'] = '1'
        assert recall.run_lex_probe('http://localhost:1', ['synthetic-wiki'],
                                    searches, 1.0, project_index=selected) is None
        assert len(daemon_calls) == 1
    finally:
        recall.urllib.request.urlopen = original
    calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
    assert len(calls) == 2
    assert all(row['index'] == selected['INDEX_PATH'] and
               row['config'] == selected['QMD_CONFIG_DIR'] and
               row['cache'] == selected['XDG_CACHE_HOME'] for row in calls)
    assert all(row['argv'][0] == 'query' and row['argv'][1] == 'lex: April cobalt pears'
               for row in calls)
    print(json.dumps({'globalDbMiss': True, 'selectedLexHit': True,
                      'failedProbeOpensGate': True,
                      'globalDaemonCalls': len(daemon_calls), 'selectedDbCalls': len(calls)}))
