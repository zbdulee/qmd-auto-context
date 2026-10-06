"""Offline Laya 0.3.20 head-only selection adapter for LocalTrainer.

Executable protocol: python laya_adapter.py MODEL_DIR train|predict|smoke REQUEST RESULT.
MODEL_DIR is an already present local Laya checkpoint. Only the explicit
artifact and response paths may be written; the base checkpoint is read-only.
"""
import hashlib
import json
import os
from pathlib import Path
import random
import stat
import sys
import tempfile

ADAPTER_VERSION = 'qmd-laya-selection-v1'
POLICY = 'binary-needed-p-ge-0.5-top3-v1'
MAX_INPUT_BYTES = 16 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
QUESTION = {'t': 'noul', 'ins': 'Is this wiki card needed to answer the user request?',
            'crit': {'false': 'not needed', 'true': 'needed'}}
MODEL_FILES = ('model.safetensors', 'rl_agent_config.json', 'encoder/config.json',
               'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json')


def _digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def model_identity(model_dir):
    root = Path(model_dir)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError('missing_local_model_dir')
    files = {}
    for name in MODEL_FILES:
        path = root/name
        if not path.is_file(): raise ValueError('missing_local_model_file:'+name)
        files[name] = _digest(path)
    return hashlib.sha256(json.dumps(files, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def prepare_base_artifact(model_dir, destination):
    """Create a private base reference without copying or changing base weights."""
    path=Path(destination)
    if not path.is_absolute() or path.exists() or path.is_symlink():
        raise ValueError('unsafe_base_artifact_path')
    parent=path.parent
    info=parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
        raise ValueError('unsafe_base_artifact_directory')
    identity=model_identity(model_dir)
    _write_json(path,{'schema_version':1,'kind':'laya_base_head',
        'base_model_sha256':identity,'adapter_version':ADAPTER_VERSION})
    return {'status':'prepared','artifact_path':str(path),'base_model_sha256':identity}


def _read_json(path):
    p = Path(path)
    if not p.is_file() or p.stat().st_size > MAX_REQUEST_BYTES:
        raise ValueError('invalid_request_file')
    return json.loads(p.read_text(encoding='utf8'))


def _write_json(path, data):
    payload = (json.dumps(data, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'))+'\n').encode()
    fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(payload); output.flush(); os.fsync(output.fileno())


def _device(torch):
    return torch.device('mps' if torch.backends.mps.is_available() else 'cpu')


def _load(model_dir, *, head_artifact=None):
    import torch
    from safetensors.torch import load_file
    from transformers import AutoTokenizer
    from transformers.initialization import no_init_weights
    from laya.common import build_model

    root = Path(model_dir)
    cfg = _read_json(root/'rl_agent_config.json')
    if not isinstance(cfg.get('max_len'), int) or cfg['max_len'] < 128 or cfg['max_len'] > 8192:
        raise ValueError('invalid_model_max_len')
    # Do not call laya.Agent: its tokenizer-repair path may replace a file in
    # the shared Hugging Face snapshot. This checkpoint is already compatible.
    tok = AutoTokenizer.from_pretrained(str(root/'tokenizer'), local_files_only=True)
    with no_init_weights():
        model = build_model(cfg, encoder_dir=str(root/'encoder'), pretrained=False)
    model.load_state_dict(load_file(str(root/'model.safetensors')), strict=True)
    if head_artifact is not None:
        head = load_file(str(head_artifact))
        expected = {k for k in model.state_dict() if not k.startswith('encoder.')}
        if set(head) != expected:
            raise ValueError('head_artifact_keys_mismatch')
        model.load_state_dict(head, strict=False)
    model.to(_device(torch))
    for p in model.encoder.parameters(): p.requires_grad_(False)
    model.eval()
    return model, tok, cfg


def _pair(prompt, candidate, tok, cfg):
    from laya.common import build_sequence, render_options, QTYPES

    body = candidate.get('input_text')
    if (not isinstance(prompt, str) or not prompt.strip() or
        not isinstance(body, str) or not body.strip() or
        len(body.encode('utf8')) > MAX_INPUT_BYTES or
        candidate.get('input_kind') not in ('full_compact_wiki_body', 'legacy_complete_excerpt')):
        raise ValueError('invalid_complete_input')
    state = 'User request:\n'+prompt+'\nWiki card body:\n'+body
    mask = tok.mask_token
    if mask in state: raise ValueError('mask_token_in_source')
    for option in render_options(QUESTION):
        if len(tok(' '+option, add_special_tokens=False)['input_ids']) > 48:
            raise ValueError('option_token_truncation')
    state_ids = tok(state, add_special_tokens=False)['input_ids']
    ids, markers = build_sequence(tok, state, QUESTION,
        max_len=cfg['max_len'], head_max_len=cfg.get('head_max_len', 192),
        state_ids=state_ids)
    instruction_ids=tok('noul question: '+QUESTION['ins'],
        add_special_tokens=False)['input_ids']
    if (ids[1:1+len(instruction_ids)]!=instruction_ids or
        len(markers) != 2 or any(ids[position]!=tok.mask_token_id for position in markers) or
        len(ids) < len(state_ids)+1 or
        ids[-len(state_ids)-1:-1] != state_ids or
        len(ids) > cfg['max_len']):
        raise ValueError('model_token_budget_exceeded')
    if tok.model_max_length < len(ids):
        raise ValueError('tokenizer_model_limit_exceeded')
    return {'ids':ids, 'markers':markers, 'qtype':QTYPES['noul']}


def _pairs(cases, tok, cfg, *, with_gold):
    if not isinstance(cases, list) or not cases or len(cases) > 2000:
        raise ValueError('invalid_case_count')
    result = []
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get('candidates'), list):
            raise ValueError('invalid_case')
        candidates = case['candidates']
        if not 1 <= len(candidates) <= 15 or len({c.get('id') for c in candidates}) != len(candidates):
            raise ValueError('invalid_candidate_pool')
        if with_gold:
            selected = case.get('selected_ids')
            if not isinstance(selected, list) or not set(selected) <= {c['id'] for c in candidates}:
                raise ValueError('invalid_train_selection')
        elif 'selected_ids' in case:
            raise ValueError('heldout_gold_exposed')
        for candidate in candidates:
            item = _pair(case.get('prompt'), candidate, tok, cfg)
            item.update(request_id=case['request_id'], candidate_id=candidate['id'])
            if with_gold: item['gold_label'] = int(candidate['id'] in selected)
            result.append(item)
    return result


def _batch(items, tok, device):
    from laya.common import collate_items
    batch = collate_items([[item] for item in items], tok.pad_token_id)
    return {name: value.to(device) for name, value in batch.items()
            if name in ('input_ids','attention_mask','marker_pos','marker_mask','qtype')}


def select_ids(scores):
    """Stable 0-3 mapping; score ties preserve candidate pool order."""
    if any(not isinstance(p, (float, int)) or not 0 <= p <= 1 for _, p in scores):
        raise ValueError('invalid_probability')
    ranked = sorted(enumerate(scores), key=lambda row:(-row[1][1], row[0]))
    return [candidate_id for _, (candidate_id, p) in ranked if p >= .5][:3]


def _save_head(path, model, base_sha):
    from safetensors.torch import save_file
    tensors = {k:v.detach().cpu().contiguous() for k,v in model.state_dict().items()
               if not k.startswith('encoder.')}
    save_file(tensors, str(path), metadata={'adapter_version':ADAPTER_VERSION,
        'selection_policy':POLICY, 'base_model_sha256':base_sha,
        'kind':'head_only'})
    os.chmod(path, 0o600)


def _head_path(artifact, base_sha):
    from safetensors import safe_open
    path = Path(artifact)
    if not path.is_file() or path.is_symlink(): raise ValueError('missing_artifact')
    with path.open('rb') as source:
        prefix = source.read(1)
    if prefix == b'{':
        manifest = _read_json(path)
        if manifest != {'schema_version':1,'kind':'laya_base_head',
                        'base_model_sha256':base_sha,'adapter_version':ADAPTER_VERSION}:
            raise ValueError('invalid_base_manifest')
        return None
    with safe_open(str(path), framework='pt', device='cpu') as source:
        meta = source.metadata()
    if meta != {'adapter_version':ADAPTER_VERSION,'selection_policy':POLICY,
                'base_model_sha256':base_sha,'kind':'head_only'}:
        raise ValueError('head_artifact_provenance_mismatch')
    return path


def train(model_dir, request, *, max_updates=None, verification=False):
    import torch
    import torch.nn.functional as F

    if request.get('schema_version') != 1 or not isinstance(request.get('artifact_path'), str):
        raise ValueError('invalid_train_request')
    artifact = Path(request['artifact_path'])
    if not artifact.is_absolute() or artifact.exists(): raise ValueError('unsafe_artifact_path')
    base_sha = model_identity(model_dir)
    model, tok, cfg = _load(model_dir)
    items = _pairs(request.get('train'), tok, cfg, with_gold=True)
    torch.manual_seed(17)
    random.Random(17).shuffle(items)
    params = [p for p in model.parameters() if p.requires_grad]
    if not params: raise ValueError('no_trainable_head')
    witness = model.scorer[-1].weight.detach().clone()
    optimizer = torch.optim.SGD(params, lr=0.01)
    model.train(); model.encoder.eval()
    updates = 0
    for start in range(0, len(items), 2):
        current = items[start:start+2]
        batch = _batch(current, tok, next(model.parameters()).device)
        targets = torch.tensor([x['gold_label'] for x in current],
            device=batch['input_ids'].device, dtype=torch.long)
        optimizer.zero_grad(set_to_none=True)
        logits, _ = model(**batch)
        if logits.shape != (len(current), 2): raise ValueError('unexpected_laya_logit_shape')
        loss = F.cross_entropy(logits.float(), targets)
        if not torch.isfinite(loss): raise ValueError('nonfinite_training_loss')
        loss.backward()
        if not all(p.grad is None or torch.isfinite(p.grad).all().item() for p in params):
            raise ValueError('nonfinite_head_gradient')
        optimizer.step()
        updates += 1
        if max_updates is not None and updates >= max_updates: break
    if not updates: raise ValueError('empty_train')
    if torch.equal(witness, model.scorer[-1].weight.detach()):
        raise ValueError('head_weights_unchanged')
    model.eval()
    probe = None
    if verification:
        item = items[0]
        with torch.no_grad():
            batch = _batch([item], tok, next(model.parameters()).device)
            probe_logits, _ = model(**batch)
        probe = {'candidate_id':item['candidate_id'],
                 'logits':probe_logits[0].detach().cpu().tolist()}
    _save_head(artifact, model, base_sha)
    response = {'schema_version':1,'status':'trained'}
    return (response, probe) if verification else response


def predict(model_dir, request):
    import torch
    if request.get('schema_version') != 1 or not isinstance(request.get('artifact_path'), str):
        raise ValueError('invalid_predict_request')
    base_sha = model_identity(model_dir)
    head = _head_path(request['artifact_path'], base_sha)
    model, tok, cfg = _load(model_dir, head_artifact=head)
    items = _pairs(request.get('cases'), tok, cfg, with_gold=False)
    by_request = {}
    with torch.no_grad():
        for item in items:
            batch = _batch([item], tok, next(model.parameters()).device)
            logits, _ = model(**batch)
            if logits.shape != (1, 2): raise ValueError('unexpected_laya_logit_shape')
            p = torch.softmax(logits[0].float(), -1)[1].item()
            by_request.setdefault(item['request_id'], []).append((item['candidate_id'], p))
    predictions = []
    for case in request['cases']:
        predictions.append({'request_id':case['request_id'],
            'input_sha256':case['input_sha256'],
            'selected_ids':select_ids(by_request[case['request_id']])})
    return {'schema_version':1,'predictions':predictions}


def smoke(model_dir, directory):
    """Actual local synthetic tokenizer, forward, one update, save/reload proof."""
    from safetensors.torch import load_file
    sample = {'request_id':'synthetic-1','input_sha256':'0'*64,
        'prompt':'Which synthetic town has the blue bridge?',
        'candidates':[{'id':'card-blue','input_kind':'full_compact_wiki_body',
                       'input_text':'Synthetic town Arin has a blue bridge. '*24},
                      {'id':'card-red','input_kind':'full_compact_wiki_body',
                       'input_text':'Synthetic town Bori has a red bridge. '*24}],
        'selected_ids':['card-blue']}
    base_sha = model_identity(model_dir)
    with tempfile.TemporaryDirectory(prefix='qmd-laya-smoke-',dir=directory) as temp:
        artifact = Path(temp)/'head.artifact'
        _, probe = train(model_dir, {'schema_version':1,
            'artifact_path':str(artifact),'train':[sample]},
            max_updates=1, verification=True)
        head = load_file(str(artifact))
        if not head: raise ValueError('empty_head_artifact')
        model, tok, cfg = _load(model_dir, head_artifact=artifact)
        matched = next(c for c in sample['candidates'] if c['id']==probe['candidate_id'])
        item = _pair(sample['prompt'], matched, tok, cfg)
        import torch
        too_long = dict(matched, input_text='synthetic overflow ' * 700)
        try:
            _pair(sample['prompt'], too_long, tok, cfg)
        except ValueError as exc:
            if str(exc) != 'model_token_budget_exceeded': raise
        else:
            raise ValueError('silent_model_token_truncation')
        with torch.no_grad():
            batch = _batch([item], tok, next(model.parameters()).device)
            reloaded_logits, _ = model(**batch)
        if not torch.allclose(reloaded_logits[0].cpu(),
                              torch.tensor(probe['logits']), rtol=1e-4, atol=1e-5):
            raise ValueError('checkpoint_reload_logits_changed')
        del model
        unlabeled = {k:v for k,v in sample.items() if k != 'selected_ids'}
        base = Path(temp)/'base.artifact'
        _write_json(base, {'schema_version':1,'kind':'laya_base_head',
            'base_model_sha256':base_sha,'adapter_version':ADAPTER_VERSION})
        base_prediction = predict(model_dir, {'schema_version':1,
            'artifact_path':str(base),'cases':[unlabeled]})
        trained_prediction = predict(model_dir, {'schema_version':1,
            'artifact_path':str(artifact),'cases':[unlabeled]})
        assert select_ids([('a',.9),('b',.8),('c',.7),('d',.6)]) == ['a','b','c']
        return {'schema_version':1,'base_model_sha256':base_sha,
            'checks':{'tokenization_no_truncation':True,'synthetic_inference':True,
                      'synthetic_one_step_train':True,'checkpoint_reload':True,
                      'fixed_selection_mapping':True},
            'base_selected_ids':base_prediction['predictions'][0]['selected_ids'],
            'trained_selected_ids':trained_prediction['predictions'][0]['selected_ids'],
            'reloaded_logits':reloaded_logits[0].cpu().tolist(),
            'synthetic_body_bytes':len(matched['input_text'].encode()),
            'model_input_tokens':len(item['ids']),
            'head_bytes':artifact.stat().st_size,'device':str(_device(__import__('torch')))}


def main(argv):
    if len(argv) != 4: raise ValueError('usage: MODEL_DIR MODE REQUEST RESULT')
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',
        HF_DATASETS_OFFLINE='1',TOKENIZERS_PARALLELISM='false',
        USE_TF='0',USE_TORCH='1')
    model_dir, mode, request_path, response_path = argv
    if mode == 'train': result = train(model_dir, _read_json(request_path))
    elif mode == 'predict': result = predict(model_dir, _read_json(request_path))
    elif mode == 'smoke': result = smoke(model_dir, Path(request_path).parent)
    else: raise ValueError('invalid_adapter_mode')
    _write_json(response_path, result)


if __name__ == '__main__':
    main(sys.argv[1:])
