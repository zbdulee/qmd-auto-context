"""Two live requests reuse synthetic runtime proof and invalidate changed inputs."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0,'core')
from context_learning import live_select,local_cycle,runtime_setup,laya_adapter
from context_learning.contracts import digest

with tempfile.TemporaryDirectory(prefix='qmd-live-proof-cache-') as name:
    state=Path(name).resolve();state.chmod(0o700)
    model=state/'model';model.mkdir()
    artifact=state/'head.bin';artifact.write_bytes(b'synthetic head');artifact.chmod(0o600)
    adapter=Path('core/context_learning/laya_adapter.py').resolve()
    def private(file,value):
        file.write_text(json.dumps(value));file.chmod(0o600)
    private(state/'active-checkpoint.json',{'schema_version':1,
        'artifact_path':str(artifact),
        'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest()})
    private(state/'live-selector.json',{'schema':'qmd-live-selector-v1',
        'trainerArgv':[sys.executable,str(adapter),str(model)],
        'timeoutSeconds':5,'maxRssMib':512})
    source='---\ntitle: Synthetic\nstatus: verified\n---\nAmber dawn.\n'
    rows=[{'id':'wiki/card.md','revision_sha256':digest(source),'source_text':source}]
    marks={'adapter':'a'*64,'model':'b'*64,'runtime':'c'*64}
    smokes=[];predicts=[]
    old=(local_cycle._hash_bytes,laya_adapter.model_identity,
         runtime_setup.probe_runtime,runtime_setup.attest_runtime,local_cycle.LocalTrainer.call)
    local_cycle._hash_bytes=lambda _:marks['adapter']
    laya_adapter.model_identity=lambda _:marks['model']
    runtime_setup.probe_runtime=lambda _: {'status':'metadata_compatible',
        'runtime_identity_sha256':marks['runtime']}
    def attest(*args,**kwargs):
        smokes.append(time.monotonic())
        att={'schema_version':1,'runtime_identity_sha256':marks['runtime'],
            'base_model_sha256':marks['model'],'adapter_sha256':marks['adapter'],
            'data_kind':'synthetic_compact_wiki',
            'checks':{key:True for key in runtime_setup.CHECKS}}
        return {'probe':runtime_setup.probe_runtime(args[0]),'attestation':att}
    runtime_setup.attest_runtime=attest
    def predict(self,mode,request,result_path,*,cwd):
        assert mode=='predict'
        predicts.append(time.monotonic())
        case=request['cases'][0]
        return ({'schema_version':1,'predictions':[{'request_id':case['request_id'],
            'input_sha256':case['input_sha256'],'selected_ids':['wiki/card.md']}]},
            {'elapsed_seconds':0.01})
    local_cycle.LocalTrainer.call=predict
    try:
        started=time.monotonic()
        assert live_select.choose(state,'first prompt',rows,corpus_fingerprint='d'*64)[1]=='selected'
        assert live_select.choose(state,'second prompt',rows,corpus_fingerprint='d'*64)[1]=='selected'
        assert len(smokes)==1 and len(predicts)==2
        cache=state/'laya-synthetic-attestation.json'
        assert cache.stat().st_mode & 0o077==0
        marks['model']='e'*64
        assert live_select.choose(state,'third prompt',rows,corpus_fingerprint='d'*64)[1]=='selected'
        assert len(smokes)==2
        saved=json.loads(cache.read_text());saved['verifiedAt']=0
        private(cache,saved)
        assert live_select.choose(state,'fourth prompt',rows,corpus_fingerprint='d'*64)[1]=='selected'
        assert len(smokes)==3
        elapsed=time.monotonic()-started
    finally:
        (local_cycle._hash_bytes,laya_adapter.model_identity,
         runtime_setup.probe_runtime,runtime_setup.attest_runtime,
         local_cycle.LocalTrainer.call)=old
    print(json.dumps({'twoPromptsOneSmoke':True,'modelChangeInvalidates':True,
        'ageInvalidates':True,'syntheticSeconds':round(elapsed,4),'externalCalls':0}))
