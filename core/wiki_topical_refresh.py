"""Recoverable one-card v2 refresh in an explicitly marked isolated project.

Every external attempt is reserved by wiki_topical_backend. Recovery may reuse
only a completed recorded response or a verified staged artifact. An uncertain
attempt is never called again automatically. Filesystem/QMD steps are repeated
idempotently until the durable reconcile baseline is settled.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

import wiki_topical as topical
import wiki_topical_backend as backend
import wiki_topical_experiment as experiment
import wiki_topical_publish as publisher
import wiki_topical_reconcile as reconcile
import topical_stop_budget as stop_budget
import wiki_topical_similarity as similarity
import wiki_verify_worker as verifier

JOURNAL = 'topical-refresh-state.json'
LOCK = '.topical-refresh.lock'
AUTO_CONFIG = '.topical-auto-refresh.json'


def _read(root: Path):
    path = root / JOURNAL
    if not path.exists() and not path.is_symlink():
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise topical.TopicalError('unsafe_auto_refresh_config') from exc
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 65536):
            raise topical.TopicalError('unsafe_refresh_journal')
        row = json.loads(os.read(fd, info.st_size + 1))
    finally:
        os.close(fd)
    if (not isinstance(row, dict) or row.get('schema') != 'qmd-topical-refresh-v1'
            or not {'batchId', 'oldGenerationId', 'oldCardId', 'oldCardSha256',
                    'sourceRoots', 'phase', 'generationId', 'preCandidates', 'engine'} <= set(row)):
        raise topical.TopicalError('invalid_refresh_journal')
    return row


def _save(root: Path, row: dict):
    reconcile._atomic(root / JOURNAL, row)


def _baseline_cards(root: Path, journal=None):
    if journal is None:
        _root, wiki, _collection = publisher._project(root)
        pages = sorted((wiki / 'topical-v2').glob('*/*.md'))
        refs = []
        for page in pages:
            if page.is_symlink() or not page.is_file():
                raise topical.TopicalError('unsafe_published_card')
            refs.append({'generationId': page.parent.name, 'cardId': page.stem})
    else:
        refs = journal.get('baselineCards')
        if not isinstance(refs, list):
            raise topical.TopicalError('refresh_baseline_missing')
    cards = []
    seen = set()
    for ref in refs:
        gid, card_id = ref['generationId'], ref['cardId']
        if card_id in seen:
            raise topical.TopicalError('duplicate_baseline_card')
        seen.add(card_id)
        manifest = json.loads(topical.read_generation_bytes(root, gid, 'manifest.json'))
        entry = next((row for row in manifest.get('cards', [])
                      if row.get('cardId') == card_id), None)
        sidecar = topical.read_generation_bytes(root, gid,
                                                f'cards/{card_id}.evidence.json')
        if entry is None or hashlib.sha256(sidecar).hexdigest() != entry.get('evidenceSha256'):
            raise topical.TopicalError('refresh_baseline_changed')
        cards.append(json.loads(sidecar))
    return refs, cards


def _recorded(root: Path, kind: str, payload: dict, attempt_id: str = 'initial'):
    """Return a completed audit response, None, or an explicit pending state."""
    request_sha = topical.digest(topical.encoded(payload))
    audit = root / 'topical-backend-audit' / f'{kind}.{request_sha}.{attempt_id}.attempt.json'
    if not audit.exists() and not audit.is_symlink():
        return None, None, None
    fd = backend._audit_fd(root)
    try:
        row = backend._read_audit(fd, audit.name)
    finally:
        os.close(fd)
    if (row.get('schema') != backend.ATTEMPT_SCHEMA or
            row.get('requestSha256') != request_sha or row.get('kind') != kind or
            row.get('attemptId') != attempt_id or
            not isinstance(row.get('transportSha256'), str) or
            len(row['transportSha256']) != 64):
        raise topical.TopicalError('backend_attempt_changed')
    if row.get('state') == 'completed' and 'adapterResponse' in row:
        return row['adapterResponse'], None, row
    return None, kind + '_attempt_' + str(row.get('state', 'unknown')), row


def _generation(root, surviving, compile_cfg, engine, pre_context, runner, recovery_only):
    payload = experiment.generation_contract(root, surviving)
    payload['existingWikiCandidates'] = pre_context
    payload['timeout'] = 420
    response, pending, _record = _recorded(root, 'generation', payload)
    if pending:
        return None, pending
    if response is not None:
        return backend.stage_generation_response(root, response, requested_sources=surviving,
                                                  reuse_existing=True), None
    if recovery_only:
        return None, 'generation_requires_explicit_backend'
    return backend.run_generation_backend(root, surviving, compile_cfg, engine,
        existing_wiki_candidates=pre_context, allow_backend_execution=True,
        runner=runner), None


def _verification(root, generation_id, card_id, compile_cfg, engine, runner, recovery_only):
    try:
        publisher._attested(root, generation_id, card_id)
        return 'backend_pass', None
    except (FileNotFoundError, topical.TopicalError):
        pass
    request = backend.verification_payload(root, generation_id, card_id)
    response, pending, audit = _recorded(root, 'verification', request)
    if pending:
        return None, pending
    if response is not None:
        selected_engine = audit.get('selectedEngine') if audit else None
        if not isinstance(selected_engine, str) or not selected_engine:
            return None, 'verification_policy_unavailable'
        if not recovery_only:
            vcfg = verifier.verify_cfg_of(compile_cfg)
            attempts, _mode, _reason = verifier.plan_verify_attempts(
                compile_cfg, vcfg, engine, set())
            if (not attempts or attempts[0]['engine'] != selected_engine or
                topical.digest(topical.encoded(attempts[0]['argv'])) != audit.get('transportSha256')):
                return None, 'verification_policy_changed'
        parsed = {key: response.get(key) for key in ('verdict', 'checks', 'reasons')}
        result = backend.validate_verification_response(root, request, parsed,
                                                       mode='backend', engine=selected_engine)
        if result['status'] == 'backend_pass':
            backend.publish_pass_attestation(root, result)
        return result['status'], None
    if recovery_only:
        return None, 'verification_requires_explicit_backend'
    result = backend.run_verification_backend(root, generation_id, card_id,
        compile_cfg, engine, allow_backend_execution=True, runner=runner)
    return result['status'], None


def refresh_one(root: Path, source_roots: list[str], old_card: dict,
                old_generation_id: str, compile_cfg: dict, engine: str, *,
                allow_backend_execution: bool = False,
                generation_runner=None, verification_runner=None,
                recovery_only: bool = False, skip_paths=()) -> dict:
    if not recovery_only and not allow_backend_execution:
        raise topical.TopicalError('backend_execution_not_enabled')
    if not recovery_only and (generation_runner is None or verification_runner is None):
        raise topical.TopicalError('explicit_backend_runner_required')
    root = experiment.require_sandbox(root)
    old_id = old_card.get('cardId') if isinstance(old_card, dict) else None
    if not isinstance(old_id, str) or not topical.CARD_ID.fullmatch(old_id):
        raise topical.TopicalError('invalid_card_id')
    lock = root / LOCK
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            raise topical.TopicalError('unsafe_refresh_lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise topical.TopicalError('refresh_busy') from exc
        return _refresh_locked(root, source_roots, old_card, old_generation_id,
                               compile_cfg, engine, generation_runner,
                               verification_runner, recovery_only, skip_paths)
    finally:
        os.close(fd)


def _refresh_locked(root, source_roots, old_card, old_generation_id,
                    compile_cfg, engine, generation_runner, verification_runner,
                    recovery_only, skip_paths):
    old_id = old_card['cardId']
    old_sha = topical.digest(topical.encoded(old_card))
    journal = _read(root)
    if journal is None:
        if recovery_only:
            return {'status': 'no_pending_refresh'}
        refs, baseline_cards = _baseline_cards(root)
        if old_card not in baseline_cards:
            raise topical.TopicalError('old_card_not_published')
        initial = reconcile.start_batch(root, source_roots, baseline_cards,
                                        trusted_card_ids=[card['cardId'] for card in baseline_cards],
                                        skip_paths=skip_paths)
        source_paths = {row['path'] for row in old_card['sourceRevisions']}
        if not initial['started'] and initial['reason'] != 'batch_running':
            return {'status': initial['reason']}
        batch = initial['batch']
        # Stop may have claimed this exact source batch before SessionStart's
        # backend worker. The refresh lock serializes refresh/create owners;
        # an existing create journal or an unrelated source batch is never
        # adopted as this card's refresh.
        create_journal = root / 'topical-create-state.json'
        if (create_journal.exists() or create_journal.is_symlink() or
                not source_paths.intersection(batch['sources'])):
            return {'status': 'batch_running'}
        if not initial['started'] and reconcile._scan(root, source_roots, skip_paths) != batch['snapshot']:
            # No refresh journal exists, so no backend attempt was made for
            # this card. Reconcile the changed source and claim its new final
            # snapshot; an already-running owner cannot pass our refresh lock.
            if not reconcile.supersede_changed_batch(root, source_roots,
                    batch['batchId'], skip_paths=skip_paths):
                return {'status': 'batch_running'}
            initial = reconcile.start_batch(root, source_roots, baseline_cards,
                trusted_card_ids=[card['cardId'] for card in baseline_cards],
                skip_paths=skip_paths)
            if not initial['started']:
                return {'status': initial['reason']}
            batch = initial['batch']
            if not source_paths.intersection(batch['sources']):
                return {'status': 'batch_running'}
        if reconcile._scan(root, source_roots, skip_paths) != batch['snapshot']:
            return {'status': 'pending_review', 'reason': 'source_changed_during_refresh'}
        journal = {'schema': 'qmd-topical-refresh-v1', 'batchId': initial['batch']['batchId'],
                   'oldGenerationId': old_generation_id, 'oldCardId': old_id,
                   'oldCardSha256': old_sha, 'sourceRoots': sorted(source_roots),
                   'phase': 'claimed', 'generationId': None, 'preCandidates': [],
                   'baselineCards': refs,
                   'skipPaths': list(skip_paths),
                   'engine': engine,
                   'compilePolicySha256': topical.digest(topical.encoded(compile_cfg))}
        _save(root, journal)
    elif (journal['oldGenerationId'] != old_generation_id or journal['oldCardId'] != old_id
          or journal['oldCardSha256'] != old_sha or journal['sourceRoots'] != sorted(source_roots)
          or journal['engine'] != engine or
          journal.get('skipPaths', []) != list(skip_paths) or
          (not recovery_only and journal.get('compilePolicySha256') !=
           topical.digest(topical.encoded(compile_cfg)))):
        raise topical.TopicalError('refresh_journal_conflict')
    _refs, baseline_cards = _baseline_cards(root, journal)
    state = reconcile._read(root)
    batch = state.get('inFlight') if state else None
    if not batch:
        if state and state.get('lastCompletedBatchId') == journal['batchId']:
            (root / JOURNAL).unlink()
            return {'status': 'already_completed', 'generationId': journal['generationId']}
        raise topical.TopicalError('refresh_batch_missing')
    if batch['batchId'] != journal['batchId']:
        raise topical.TopicalError('refresh_batch_changed')
    if reconcile._scan(root, source_roots, skip_paths) != batch['snapshot']:
        return {'status': 'pending_review', 'reason': 'source_changed_during_refresh'}
    projection = reconcile.safe_projection(root, source_roots, baseline_cards,
        trusted_card_ids=[card['cardId'] for card in baseline_cards], skip_paths=skip_paths)
    if projection[old_id]['state'] != 'excluded_stale':
        raise topical.TopicalError('stale_card_required')
    surviving = sorted({row['path'] for row in old_card['sourceRevisions']
                        if row['path'] in batch['snapshot']})
    if len(surviving) > 3:
        raise topical.TopicalError('too_many_refresh_sources')
    generation_id = journal['generationId']
    new_cards = []
    if surviving:
        if journal['phase'] == 'claimed':
            lead = ' '.join(old_card['lead'].split())
            try:
                matches = similarity.retrieve(root, lead, exclude=(old_generation_id, old_id))
            except topical.TopicalError as exc:
                return {'status': 'pending_review', 'reason': exc.code}
            journal['preCandidates'] = [{'path': x['path'], 'lead': x['lead']} for x in matches]
            journal['phase'] = 'pre_retrieved'; _save(root, journal)
        if generation_id is None:
            try:
                generated, pending = _generation(root, surviving, compile_cfg, engine,
                                                  journal['preCandidates'], generation_runner,
                                                  recovery_only)
            except topical.TopicalError as exc:
                return {'status': 'pending_review', 'reason': exc.code}
            if pending:
                return {'status': 'pending_review', 'reason': pending}
            generation_id = generated['generationId']
            if [row['cardId'] for row in generated['cards']] != [old_id]:
                return {'status': 'pending_review', 'reason': 'replacement_card_id_mismatch'}
            journal['generationId'] = generation_id
            journal['phase'] = 'generated'; _save(root, journal)
        try:
            verified, pending = _verification(root, generation_id, old_id,
                                              compile_cfg, engine, verification_runner,
                                              recovery_only)
        except topical.TopicalError as exc:
            return {'status': 'pending_review', 'reason': exc.code}
        if pending:
            return {'status': 'pending_review', 'reason': pending}
        if verified != 'backend_pass':
            return {'status': 'pending_review', 'reason': 'replacement_backend_pass_required'}
        journal['phase'] = 'verified'; _save(root, journal)
        card = experiment.load_staged_card(root, generation_id, old_id)
        new_cards = [card]
        try:
            matches = similarity.retrieve(root, card['lead'], exclude=[
                (old_generation_id, old_id), (generation_id, old_id)])
        except topical.TopicalError as exc:
            return {'status': 'pending_review', 'reason': exc.code}
        result = similarity.evaluate(root, card, generation_id, matches)
        journal['similarity'] = result
        if result['status'] == 'pending_review':
            journal['phase'] = 'awaiting_similarity'; _save(root, journal)
            return {'status': 'pending_review', 'reason': 'similarity_unresolved',
                    'pairs': result['pairs']}
        journal['phase'] = 'similarity_clear'; _save(root, journal)
    if reconcile._scan(root, source_roots, skip_paths) != batch['snapshot']:
        return {'status': 'pending_review', 'reason': 'source_changed_during_refresh'}
    if new_cards:
        publisher.publish(root, generation_id, old_id)
        journal['phase'] = 'new_published'; _save(root, journal)
    retired = publisher.retire_stale(root, old_generation_id, old_id,
                                     source_roots, [old_card])
    journal['phase'] = 'old_retired'; _save(root, journal)
    ready = publisher.sync(root, allow_empty=not new_cards, allow_stale=True,
                           reclaim_retired=True)
    journal['phase'] = 'qmd_synced'; _save(root, journal)
    finished = reconcile.finish_backend_batch(root, source_roots,
        batch['batchId'], generation_id, new_cards, old_card_id=old_id,
        settled_paths=[row['path'] for row in old_card['sourceRevisions']],
        skip_paths=skip_paths)
    (root / JOURNAL).unlink()
    return {'status': 'backend_verified_synced', 'retired': retired,
            'ready': ready, 'finished': finished, 'generationId': generation_id,
            'replacementCards': len(new_cards)}


def recover_pending(root: Path) -> dict:
    """One-shot recovery of recorded work; never initiates an external call."""
    root = experiment.require_sandbox(root)
    journal = _read(root)
    if journal is None:
        return {'status': 'no_pending_refresh'}
    try:
        old = json.loads(topical.read_generation_bytes(root, journal['oldGenerationId'],
            f"cards/{journal['oldCardId']}.evidence.json"))
        result = refresh_one(root, journal['sourceRoots'], old,
            journal['oldGenerationId'], {}, journal['engine'], recovery_only=True,
            skip_paths=journal.get('skipPaths', []))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result = {'status': 'pending_review', 'reason': getattr(exc, 'code', 'recovery_unavailable')}
    return result


def read_auto_policy(root: Path) -> dict | None:
    """Read the full owner policy before a hook may scan or claim work."""
    root = experiment.require_sandbox(root)
    path = root / AUTO_CONFIG
    if not path.exists() and not path.is_symlink():
        return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 65536):
            raise topical.TopicalError('unsafe_auto_refresh_config')
        try:
            cfg = json.loads(os.read(fd, info.st_size + 1))
        except (ValueError, UnicodeDecodeError) as exc:
            raise topical.TopicalError('invalid_auto_refresh_config') from exc
    finally:
        os.close(fd)
    if (not isinstance(cfg, dict) or set(cfg) != {'schema', 'enabled', 'sourceRoots',
            'engine', 'compileCfg', 'maxEstimatedCents'} or
            cfg['schema'] != 'qmd-topical-auto-refresh-v1' or
            type(cfg['enabled']) is not bool or cfg['engine'] != 'codex' or
            not isinstance(cfg['sourceRoots'], list) or not cfg['sourceRoots'] or
            not isinstance(cfg['compileCfg'], dict) or
            type(cfg['maxEstimatedCents']) is not int or
            not 20 <= cfg['maxEstimatedCents'] <= 160):
        raise topical.TopicalError('invalid_auto_refresh_config')
    try:
        if not all(isinstance(value, str) and
                   reconcile.safe_rel(value, explicit_root=True) == value
                   for value in cfg['sourceRoots']):
            raise ValueError('invalid_source_root')
    except ValueError as exc:
        raise topical.TopicalError('invalid_auto_refresh_config') from exc
    return cfg


def auto_refresh_pending(root: Path, *, generation_runner=None,
                         verification_runner=None, skip_paths=(),
                         expected_policy_sha256=None) -> dict:
    """One bounded, explicitly opted-in project card/source operation."""
    root = experiment.require_sandbox(root)
    cfg = read_auto_policy(root)
    if cfg is None:
        return {'status': 'pending_review', 'reason': 'auto_teacher_policy_required'}
    if not cfg['enabled']:
        return {'status': 'disabled'}
    if (expected_policy_sha256 is not None and
            stop_budget._digest(cfg) != expected_policy_sha256):
        return {'status': 'pending_review', 'reason': 'stop_batch_policy_changed'}
    source_roots = cfg['sourceRoots']
    publisher._project(root)
    publisher._qmd_runtime(root)
    state = reconcile._read(root)
    if state is None or state.get('sourceRoots') != sorted(set(source_roots)):
        return {'status': 'pending_review', 'reason': 'reconcile_baseline_required'}
    journal = _read(root)
    if journal is not None:
        _refs, cards = _baseline_cards(root, journal)
        old = next((card for card in cards if card['cardId'] == journal['oldCardId']), None)
        if old is None:
            raise topical.TopicalError('refresh_baseline_missing')
        gid = journal['oldGenerationId']
    else:
        import wiki_topical_create as creator
        create_journal = creator._read(root)
        if create_journal is not None:
            return creator.create_one(root, source_roots, create_journal['sourcePath'],
                cfg['compileCfg'], cfg['engine'], cfg['maxEstimatedCents'],
                generation_runner=generation_runner or backend.worker.run_extractor,
                verification_runner=verification_runner or backend.worker.run_extractor,
                skip_paths=skip_paths)
        refs, cards = _baseline_cards(root)
        projection = reconcile.safe_projection(root, source_roots, cards,
            trusted_card_ids=[card['cardId'] for card in cards], skip_paths=skip_paths)
        stale = sorted(card_id for card_id, row in projection.items()
                       if row['state'] == 'excluded_stale')
        active_batch = state.get('inFlight') if state else None
        active_paths = set(active_batch['sources']) if active_batch else set()
        if stale and active_paths:
            # A batch claimed for another card or a newly created source must
            # not be taken over by the alphabetically first stale card.
            matching = [card_id for card_id in stale if any(
                row['path'] in active_paths for row in next(
                    card for card in cards if card['cardId'] == card_id)['sourceRevisions'])]
            if matching:
                stale = matching
            else:
                claimed_paths = {row['path'] for card in cards
                                 for row in card['sourceRevisions']}
                new_paths = sorted(path for path in active_paths
                                   if path not in claimed_paths and
                                   state['queue'].get(path, {}).get('currentSha256') is not None)
                if new_paths:
                    return creator.create_one(root, source_roots, new_paths[0],
                        cfg['compileCfg'], cfg['engine'], cfg['maxEstimatedCents'],
                        generation_runner=generation_runner or backend.worker.run_extractor,
                        verification_runner=verification_runner or backend.worker.run_extractor,
                        skip_paths=skip_paths)
                return {'status': 'batch_running'}
        if not stale:
            claimed = {row['path'] for card in cards for row in card['sourceRevisions']}
            unclaimed = [path for path, row in sorted(state['queue'].items())
                         if path not in claimed and row['currentSha256'] is not None]
            if unclaimed:
                return creator.create_one(root, source_roots, unclaimed[0],
                    cfg['compileCfg'], cfg['engine'], cfg['maxEstimatedCents'],
                    generation_runner=generation_runner or backend.worker.run_extractor,
                    verification_runner=verification_runner or backend.worker.run_extractor,
                    skip_paths=skip_paths)
            if state['queue']:
                return {'status': 'pending_review', 'reason': 'unclaimed_source_change'}
            return {'status': 'no_net_changes'}
        old_id = stale[0]
        old = next(card for card in cards if card['cardId'] == old_id)
        gid = next(ref['generationId'] for ref in refs if ref['cardId'] == old_id)
    return refresh_one(root, source_roots, old, gid, cfg['compileCfg'], cfg['engine'],
        allow_backend_execution=True,
        generation_runner=generation_runner or backend.worker.run_extractor,
        verification_runner=verification_runner or backend.worker.run_extractor,
        skip_paths=skip_paths)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('recover', 'auto'):
        raise SystemExit(2)
    fn = recover_pending if sys.argv[1] == 'recover' else auto_refresh_pending
    print(json.dumps(fn(Path(sys.argv[2])), ensure_ascii=False, sort_keys=True))
