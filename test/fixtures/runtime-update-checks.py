"""Update inventory and shadow migration preserve the original DB and user state."""
import json
import os
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import sys
import tempfile

sys.path.insert(0,'core')
import wiki_topical as topical
import runtime_update as update

with tempfile.TemporaryDirectory(prefix='qmd-runtime-update-') as name:
    root=Path(name).resolve();(root/topical.MARKER).write_text('synthetic only\n')
    config=root/'qmd-config/index.yml';config.parent.mkdir()
    config.write_text('collections: {}\nmodels:\n  embed: synthetic-model\n')
    wiki=root/'.auto-context/wiki';wiki.mkdir(parents=True)
    (wiki/'card.md').write_text('Synthetic card.\n')
    cache=root/'qmd-cache/qmd/models';cache.mkdir(parents=True)
    qmd=root/'qmd';qmd.write_text('synthetic executable');qmd.chmod(0o700)
    old=root/'old.sqlite'
    def make_index(path,dim):
        with sqlite3.connect(path) as db:
            db.executescript('CREATE TABLE documents(collection TEXT,path TEXT,active INTEGER);'
                'CREATE TABLE content(hash TEXT);'
                'CREATE TABLE content_vectors(hash TEXT,seq INTEGER,model TEXT,embed_fingerprint TEXT);'
                'CREATE TABLE store_collections(name TEXT);'
                f'CREATE TABLE vectors_vec(embedding "float[{dim}] distance_metric=cosine");')
            db.execute('INSERT INTO documents VALUES (?,?,1)',('wiki','card.md'))
            db.execute('INSERT INTO content_vectors VALUES (?,?,?,?)',('x',0,'synthetic-model','f1'))
    make_index(old,768)
    original=update.inspect_index(old)
    target={'qmdVersion':'2.5.3','qmdCapabilities':['vsearch'],
        'indexSchemaSha256':original['schemaSha256'],
        'embeddingDimension':768,'vectorFormat':'vec0-cosine',
        'modelFingerprints':original['modelFingerprints'],
        'layaRuntimeIdentitySha256':'a'*64,'checkpointArchitecture':'head-v1',
        'tokenizerSha256':'b'*64,'labelSchema':update.LABEL_SCHEMA}
    current={'qmd':{'version':'2.5.3','capabilities':['vsearch']},'index':original,
        'wikiVersions':[2],'laya':{'runtimeIdentitySha256':'a'*64,
        'checkpointArchitecture':'head-v1','tokenizerSha256':'b'*64,
        'labelSchema':update.LABEL_SCHEMA},'goldSchema':1,'trainingSchema':1}
    assert update.plan_update(current,target)['status']=='compatible'
    old_versions=dict(current,qmd={'version':'2.4.0','capabilities':[]},wikiVersions=[1,2])
    old_plan=update.plan_update(old_versions,target)
    assert old_plan['status']=='review_required'
    assert 'stage_qmd_runtime' in old_plan['actions']
    assert 'wiki_version_requires_preserving_migration' in old_plan['holds']
    changed=dict(target,embeddingDimension=1024)
    assert update.plan_update(current,changed)['actions']==['stage_shadow_index_and_reembed']
    incompatible=dict(current,laya=dict(current['laya'],tokenizerSha256='c'*64),goldSchema=2)
    held=update.plan_update(incompatible,target)
    assert set(held['holds'])=={'preserve_incompatible_checkpoint',
                               'preserve_incompatible_gold_and_training_history'}
    private=root/'.auto-context/context-learning';private.mkdir(parents=True)
    preserved={name:(private/name) for name in ('checkpoint.bin','gold.jsonl','history.jsonl')}
    for name,path in preserved.items():path.write_bytes(('synthetic '+name+'\n').encode())
    preserved_bytes={name:path.read_bytes() for name,path in preserved.items()}
    before=old.read_bytes()
    def runner(command,*,cwd,env,**kwargs):
        assert env['INDEX_PATH']!=str(old)
        assert env['QMD_CONFIG_DIR'].startswith(str(root))
        assert env['XDG_CACHE_HOME'].startswith(str(root))
        if command[1]=='update':make_index(Path(env['INDEX_PATH']),768)
        return SimpleNamespace(returncode=0,stdout='[]' if command[1]=='vsearch' else '')
    os.environ['INDEX_PATH']=str(old)
    def interrupted(command,*,cwd,env,**kwargs):
        assert env['INDEX_PATH']!=str(old)
        if command[1]=='update':make_index(Path(env['INDEX_PATH']),768)
        return SimpleNamespace(returncode=1 if command[1]=='embed' else 0,stdout='')
    try:
        update.stage_shadow_index(root,qmd_bin=qmd,config_file=config,
            wiki_dir=wiki,model_cache=cache.parent.parent,
            expected_model='synthetic-model',expected_dimension=768,
            allow_execution=True,runner=interrupted)
        raise AssertionError('interrupted shadow build unexpectedly succeeded')
    except ValueError as error:
        assert str(error)=='shadow_index_build_failed'
    assert not (root/'.auto-context/qmd-index-active.json').exists()
    assert old.read_bytes()==before
    failed_generations=list((root/'.auto-context/qmd-index-generations').iterdir())
    assert len(failed_generations)==1 and not (failed_generations[0]/'prepared.json').exists()
    staged=update.stage_shadow_index(root,qmd_bin=qmd,config_file=config,
        wiki_dir=wiki,model_cache=cache.parent.parent,
        expected_model='synthetic-model',expected_dimension=768,
        allow_execution=True,runner=runner)
    assert staged['status']=='staged_inactive' and Path(staged['index']).is_file()
    assert old.read_bytes()==before and not (root/'.auto-context/qmd-index-active.json').exists()
    activated=update.activate_shadow_index(root,staged['generation'])
    assert activated['status']=='index_selected'
    assert update.select_index(root)==Path(staged['index'])
    assert old.read_bytes()==before
    assert all(path.read_bytes()==preserved_bytes[name] for name,path in preserved.items())
    rolled=update.rollback_shadow_index(root)
    assert rolled['status']=='index_rolled_back_original'
    assert not (root/'.auto-context/qmd-index-active.json').exists()
    assert old.read_bytes()==before
    assert all(path.read_bytes()==preserved_bytes[name] for name,path in preserved.items())
    print(json.dumps({'oldVersionStaged':True,'v1WikiHeld':True,
        'interruptedStageRetry':True,'rollbackPreservedHistory':True,
        'compatibleNoReinstall':True,'changedDimensionStagesNewIndex':True,
        'incompatibleUserStatePreserved':True,'oldDbUnchanged':True,'noCutover':True}))
