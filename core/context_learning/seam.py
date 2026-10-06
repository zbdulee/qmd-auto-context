"""Opt-in capture of current source snapshots; never changes recall selection."""
import os
from pathlib import Path
import uuid

from .contracts import digest, request
from .store import capture
import hashlib
import stat

def _snapshot(path):
    # Bound bytes before decoding or hashing, including concurrent growth.
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            return None
        content = handle.read(65537)
        after = os.fstat(handle.fileno())
    if len(content) > 65536 or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        return None
    return {"sha256": hashlib.sha256(content).hexdigest()}, content


def _private_state(config, root):
    configured = config.get('contextLearning', {}).get('stateRoot')
    if not isinstance(configured, str):
        return None
    parent = Path(configured)
    if not parent.is_absolute() or not parent.is_dir():
        return None
    # Existing explicit root only; reject symlink components and indexed roots.
    if any(p.is_symlink() for p in (parent, *parent.parents)):
        return None
    parent = parent.resolve(strict=True)
    if parent == root or root in parent.parents:
        return None
    for base in config.get('collectionPaths', {}).values():
        collection_root = (root / base).resolve()
        if parent == collection_root or collection_root in parent.parents:
            return None
    info = parent.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        return None
    namespace = digest(str(root))
    state = parent / namespace
    if state.is_symlink():
        return None
    state.mkdir(mode=0o700, exist_ok=True)
    info = state.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        return None
    return state


def _id(hit):
    file = hit.get('file', '')
    if not isinstance(file,str) or not file:
        raise ValueError('invalid_candidate_id')
    return file[6:] if file.startswith('qmd://') else file


def observe(payload, config, project_root, final_results, *, phases=None, verdict=None,
            candidate_limit=None, qmd_paths=None):
    opts = config.get('contextLearning', {})
    if not isinstance(opts, dict) or opts.get('capture') is not True:
        return 'disabled'
    try:
        root = Path(project_root).resolve(strict=True)
        state = _private_state(config, root)
        if state is None:
            return 'unsafe_or_missing_state'
        from .corpus import snapshot as corpus_snapshot, reconcile as reconcile_corpus
        current_corpus = corpus_snapshot(root, config, qmd_paths=qmd_paths)
        indexed_hashes = ({(collection, relative): revision
            for collection, relative, revision in current_corpus['material']['activeDocuments']}
            if current_corpus else {})
        # Legacy direct callers retain final-selected-only schema v1.
        pool_mode = phases is not None and verdict is not None
        phases = phases if pool_mode else [{'name':'primary','results':final_results,'wiki_scoped':False,'returned_count':len(final_results)}]
        expanded = pool_mode and candidate_limit is not None
        phase_limit = 30 if expanded else 8
        rows=[]; eligible=[]; excluded=[]; failures=[]; seen=set(); counts={}; assessed=True
        compact_sources={}
        for phase in phases:
            counts[phase['name']]=phase['returned_count']
            for hit in phase['results'][:phase_limit]:
                file=_id(hit)
                decision=verdict(hit,phase['wiki_scoped']) if pool_mode else 'eligible'
                if decision!='eligible':
                    excluded.append({'candidate_id':file,'phase':phase['name'],'reason':decision})
                    if decision in {'observation_budget','eligibility_error'}:
                        assessed=False
                    continue
                if file in seen:
                    continue
                seen.add(file);eligible.append(file)
                collection,sep,relative=file.partition('/')
                base=config.get('collectionPaths',{}).get(collection)
                reason='unresolvable_collection'
                try:
                    if not sep or not isinstance(base,str):
                        raise ValueError(reason)
                    base_path=(root/base).resolve(strict=True)
                    path=(base_path/relative).resolve(strict=True)
                    if root not in path.parents or base_path not in path.parents:
                        raise ValueError('outside_allowed_root')
                    snap=_snapshot(path)
                    if snap is None:
                        raise ValueError('oversize_unstable_or_nonregular')
                    revision,content=snap
                    if current_corpus is not None and indexed_hashes.get((collection, relative)) != revision['sha256']:
                        raise ValueError('candidate_index_stale')
                    source_text=content.decode('utf-8')
                    excerpt=source_text
                    if config.get('collectionRoles',{}).get(collection) == 'wiki':
                        # Store the exact body separately; bounded excerpts still
                        # serve the optional teacher transport contract.
                        from .compact_input import derive
                        try:
                            compact=derive(source_text, revision['sha256'])
                            excerpt=compact['body_text']
                            compact_sources[file]=source_text
                        except ValueError:
                            pass  # Captured for review, excluded from local training.
                    rows.append({'candidate_id':file,'revision_sha256':revision['sha256'],'eligible':True,'excerpt':excerpt})
                except UnicodeError:
                    failures.append({'candidate_id':file,'reason':'invalid_utf8'})
                except ValueError as exc:
                    failures.append({'candidate_id':file,'reason':str(exc)})
                except (OSError,UnicodeError):
                    failures.append({'candidate_id':file,'reason':'missing_unreadable_or_encoding'})
        sampling=None
        if pool_mode:
            captured=[r['candidate_id'] for r in rows]
            truncated=any(v>phase_limit for v in counts.values())
            sampling={'mode':'eligible-policy-pool' if expanded else 'eligible-returned-pool','scope':'queried-phases-only',
                      'phase_counts':counts,'per_phase_limit':phase_limit,'eligible_ids':eligible,'captured_ids':captured,
                      'baseline_selected_ids':list(dict.fromkeys(_id(h) for h in final_results)),
                      'excluded':excluded,'snapshot_failures':failures,'retrieval_truncated':truncated,
                      'assessment_complete':assessed,'complete_within_returned_bound':assessed and not (expanded and any(x['reason']=='candidate_budget' for x in excluded)) and not truncated and not failures and set(eligible)==set(captured),
                      'index_revision':current_corpus['fingerprint'] if current_corpus else 'unavailable'}
            if expanded:
                sampling['candidate_limit'] = candidate_limit
        elif not rows:
            return 'no_snapshot_candidates'
        sample=request(payload,rows,host=os.environ.get('QMD_ENGINE','claude'),request_id=str(uuid.uuid4()),sampling=sampling)
        status = capture(sample,enabled=True,state_dir=state,compact_sources=compact_sources)
        if status == 'stored' and current_corpus is not None:
            reconcile_corpus(state, current_corpus)
        return status
    except Exception:
        return 'capture_unavailable'
