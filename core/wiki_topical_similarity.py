"""Isolated QMD candidate retrieval and conservative v2 duplicate gate.

QMD vector scores locate possible comparisons; they never decide semantic
equivalence. Exact copies and every unresolved pair are held for explicit
review. This module has no teacher transport and cannot merge or delete cards.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat

import wiki_topical as topical
import wiki_topical_experiment as experiment
import wiki_topical_publish as publisher
from wiki_topical_selection import exact_card_identity

MAX_RESULTS = 8
SEARCH_LIMIT = 32
REVIEW_FILE = 'topical-similarity-review.json'


def _review(root: Path) -> dict:
    path = root / REVIEW_FILE
    if not path.exists():
        return {}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 65536):
            raise topical.TopicalError('unsafe_similarity_review')
        value = json.loads(os.read(fd, info.st_size + 1))
    finally:
        os.close(fd)
    if (not isinstance(value, dict) or value.get('schema') != 'qmd-topical-similarity-review-v1'
            or not isinstance(value.get('decisions'), list)):
        raise topical.TopicalError('invalid_similarity_review')
    decisions = {}
    for row in value['decisions']:
        if (not isinstance(row, dict) or set(row) != {'pairSha256', 'verdict', 'reviewerId', 'reason'}
                or not isinstance(row['pairSha256'], str) or len(row['pairSha256']) != 64
                or row['verdict'] not in ('distinct', 'duplicate', 'conflict', 'unclear')
                or not isinstance(row['reviewerId'], str) or not row['reviewerId'].strip()
                or not isinstance(row['reason'], str) or not row['reason'].strip()
                or row['pairSha256'] in decisions):
            raise topical.TopicalError('invalid_similarity_review')
        decisions[row['pairSha256']] = row
    return decisions


def retrieve(root: Path, text: str, *,
             exclude: tuple[str, str] | list[tuple[str, str]] | None = None) -> list[dict]:
    """Use this project's vector index, then revalidate each returned page."""
    root, wiki, collection = publisher._project(root)
    runtime = publisher._qmd_runtime(root)
    query = ' '.join(text.split())[:1000]
    excluded = ({exclude} if isinstance(exclude, tuple) else set(exclude or []))
    if len(query) < 3:
        return []
    result = publisher._call(root, runtime, ['vsearch', query, '-c', collection,
                                            '-n', str(SEARCH_LIMIT), '--format', 'json'])
    try:
        hits = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise topical.TopicalError('similarity_search_unavailable') from exc
    if not isinstance(hits, list) or len(hits) >= SEARCH_LIMIT:
        raise topical.TopicalError('similarity_search_unavailable')
    db = sqlite3.connect(runtime['INDEX_PATH'])
    matches = []
    try:
        db.execute('PRAGMA query_only=ON')
        for hit in hits:
            if not isinstance(hit, dict) or not isinstance(hit.get('file'), str):
                raise topical.TopicalError('invalid_similarity_hit')
            prefix = 'qmd://' + collection + '/'
            if not hit['file'].startswith(prefix):
                raise topical.TopicalError('invalid_similarity_hit')
            rel = hit['file'][len(prefix):]
            parts = Path(rel).parts
            if (len(parts) != 3 or parts[0] != 'topical-v2'
                    or not experiment.GENERATION_ID.fullmatch(parts[1])
                    or not parts[2].endswith('.md')
                    or not topical.CARD_ID.fullmatch(parts[2][:-3])):
                # A returned wiki page outside the verified v2 format can
                # still be a duplicate. The caller needs a manual migration
                # decision before publishing a replacement.
                raise topical.TopicalError('similarity_unreviewed_wiki_hit')
            gid, card_id = parts[1], parts[2][:-3]
            if (gid, card_id) in excluded:
                continue
            page = wiki / rel
            if page.is_symlink() or not page.is_file():
                raise topical.TopicalError('similarity_candidate_missing')
            content = page.read_bytes()
            row = db.execute('SELECT hash FROM documents WHERE collection=? AND path=? AND active=1',
                             (collection, rel)).fetchone()
            if row is None or row[0] != hashlib.sha256(content).hexdigest():
                raise topical.TopicalError('similarity_index_stale')
            sidecar = json.loads(topical.read_generation_bytes(root, gid,
                f'cards/{card_id}.evidence.json'))
            if any(not (root / revision['path']).is_file() or
                hashlib.sha256((root / revision['path']).read_bytes()).hexdigest() != revision['sha256']
                for revision in sidecar['sourceRevisions']):
                # A stale indexed page remains a recall-filtered retirement
                # candidate, not a current semantic comparison.
                continue
            publisher._attested(root, gid, card_id)
            card = experiment.load_staged_card(root, gid, card_id)
            staged_sha = hashlib.sha256(topical.read_generation_bytes(root, gid,
                f'cards/{card_id}.md')).hexdigest()
            matches.append({'generationId': gid, 'cardId': card_id, 'path': rel,
                            'pageSha256': staged_sha, 'card': card,
                            'lead': card['lead'][:600]})
            if len(matches) > MAX_RESULTS:
                raise topical.TopicalError('similarity_review_budget_exceeded')
    finally:
        db.close()
    return matches


def evaluate(root: Path, proposed: dict, generation_id: str,
             matches: list[dict]) -> dict:
    """Pass only when every candidate is independently marked distinct."""
    root = experiment.require_sandbox(root)
    proposed_page = topical.read_generation_bytes(root, generation_id,
                                                   f"cards/{proposed['cardId']}.md")
    proposed_sha = hashlib.sha256(proposed_page).hexdigest()
    decisions = _review(root)
    rows = []
    for item in matches:
        pair = topical.digest(topical.encoded(['qmd-topical-pair-v1',
                                               *sorted((proposed_sha, item['pageSha256']))]))
        exact = exact_card_identity(proposed) == exact_card_identity(item['card'])
        proposed_scopes = {(c['statement'].strip().casefold(), c['state'],
                            c['timeScope'], c['condition']) for c in proposed['claims']}
        existing_scopes = {(c['statement'].strip().casefold(), c['state'],
                            c['timeScope'], c['condition']) for c in item['card']['claims']}
        shared_statements = {row[0] for row in proposed_scopes} & {
            row[0] for row in existing_scopes}
        scoped_difference = bool(shared_statements and proposed_scopes != existing_scopes)
        decision = decisions.get(pair)
        verdict = 'exact_duplicate' if exact else decision['verdict'] if decision else 'unresolved'
        rows.append({'pairSha256': pair, 'candidatePath': item['path'],
                     'verdict': verdict,
                     'relation': 'exact_fact_and_provenance' if exact else
                                 'state_time_or_condition_difference' if scoped_difference else
                                 'semantic_review_required',
                     'scope': [{'state': c['state'], 'timeScope': c['timeScope'],
                                'condition': c['condition']} for c in item['card']['claims']]})
    pending = [row for row in rows if row['verdict'] != 'distinct']
    return {'status': 'pending_review' if pending else 'distinct_or_no_candidates',
            'proposedSha256': proposed_sha, 'pairs': rows, 'pending': len(pending)}
