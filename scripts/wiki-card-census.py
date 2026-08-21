"""읽기 전용: 카드 인구조사(§1/§2 갱신) + 3.8 건전 백필 분류(dry-run)."""
import sys, os, glob, json, subprocess, collections
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, '/Users/dulee/work/qmd-auto-context/core')
import recall as R, wiki_freshness as WF, yaml_scalars as YS

META = {'index.md', 'log.md', 'SCHEMA.md'}
PROJECTS = ['service-engineering', 'ktlo-check', 'rccar', 'ai-proxy', 'qmd-auto-context', 'novela', 'axiom']

def wiki_root(root):
    p = root / '.auto-context/settings.json'
    if not p.is_file(): return None, {}
    cfg = json.loads(p.read_text())
    if cfg.get('indexing') is not True: return None, cfg
    w = root / cfg.get('wikiPath', '.auto-context/wiki')
    return (w if w.is_dir() else None), cfg

def at(value):
    """ISO 문자열 → aware datetime.

    **문자열끼리 비교하면 안 된다.** git `%cI`는 로컬 오프셋(`+09:00`)으로, 매니페스트 `ts`는
    UTC(`Z`)로 찍힌다 — 같은 순간을 문자열로 비교하면 `+09:00` 쪽이 9시간 늦게 읽히고,
    편향이 **한 방향**이라 "원문이 컴파일보다 새로움"이 과다 집계된다(= 건전 백필 가능이
    과소 집계). 실측으로 이 한 줄이 3.8 대상을 44장으로 보고했고 시각 비교로는 105장이다.
    같은 실행을 여러 번 해도 같은 답이 나오므로 **재현성으로는 이 오류를 잡을 수 없다.**
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def git_last_commit(root, rel, cache):
    if rel in cache: return cache[rel]
    r = subprocess.run(['git', '-C', str(root), 'log', '-1', '--format=%cI', '--', rel],
                       capture_output=True, text=True)
    cache[rel] = r.stdout.strip() or None
    return cache[rel]

for name in PROJECTS:
    root = Path.home() / 'work' / name
    w, cfg = wiki_root(root)
    if w is None:
        print(f'{name}: wiki 없음 (indexing={cfg.get("indexing")})'); continue

    # 매니페스트: targetPath -> 최신 created/updated 레코드
    latest = {}
    mf = root / '.auto-context/compile/generated-manifest.jsonl'
    if mf.is_file():
        for ln in mf.open(errors='replace'):
            try: o = json.loads(ln)
            except Exception: continue
            tp, ts = o.get('targetPath'), o.get('ts')
            if not (isinstance(tp, str) and isinstance(ts, str)): continue
            if o.get('action') not in ('created', 'updated'): continue
            prev = latest.get(tp)
            if prev is None or ts > prev['ts']: latest[tp] = o

    pending = WF.unresolved_pending_refreshes(root)
    pmap = {}
    for ev in pending:
        sp = ev.get('sourcePath')
        if isinstance(sp, str): pmap[sp] = ev

    c = collections.Counter(); cls = collections.Counter(); gl = {}
    dirty = {l[3:].strip() for l in subprocess.run(
        ['git', '-C', str(root), 'status', '--porcelain'],
        capture_output=True, text=True).stdout.split('\n') if len(l) > 3}

    for f in glob.glob(str(w / '**/*.md'), recursive=True):
        p = Path(f)
        if p.name in META: continue
        c['cards'] += 1
        txt = p.read_text(errors='replace')
        fm = R.parse_frontmatter_scalars(txt)
        status = (fm.get('status') or '').strip('"')
        if status != 'verified': c['not_verified'] += 1; continue
        if (fm.get('createdBy') or '').strip('"') != 'qmd-auto-context':
            c['foreign'] += 1; continue
        revs = R.frontmatter_source_revisions(txt)
        if not revs:
            c['norev'] += 1
            rel = os.path.relpath(f, root)
            o = latest.get(rel)
            srcs = [s.get('path') for s in (o.get('sources') or [])
                    if isinstance(s, dict) and s.get('kind') == 'file'
                    and isinstance(s.get('path'), str)] if o else []
            if not o or len(srcs) != 1: cls['판정불가(ts없음/다중소스)'] += 1; continue
            src = srcs[0]
            if not (root / src).is_file(): cls['원문소실→source-missing'] += 1; continue
            if src in dirty: cls['워킹트리 dirty'] += 1; continue
            lc = git_last_commit(root, src, gl)
            if not lc: cls['git이력없음'] += 1; continue
            lcd, tsd = at(lc), at(o['ts'])
            if lcd is None or tsd is None: cls['시각파싱실패'] += 1; continue
            cls['원문이 컴파일보다 새로움→재컴파일' if lcd > tsd else '건전 백필 가능'] += 1
            continue
        # freshness (raw) + pending cutoff (effective)
        state = 'fresh'
        for e in revs:
            n = YS.normalize_source_revision(e)
            if n is None: state = 'unknown'; break
            sp = root / n['path']
            if not sp.is_file(): state = 'stale'; break
            snap = WF.snapshot_file(sp)
            if snap is None: state = 'unknown'; break
            if snap['sha256'] != n['sha256']: state = 'stale'; break
        c[state] += 1
        if state == 'fresh':
            eff = 'fresh_eff'
            for e in revs:
                n = YS.normalize_source_revision(e)
                if n and n['path'] in pmap: eff = 'pending_cut'; break
            c[eff] += 1

    print(f'== {name}: 카드 {c["cards"]}  |  fresh {c["fresh"]} (실효 {c["fresh_eff"]}, pending컷 {c["pending_cut"]})  '
          f'stale {c["stale"]}  unknown {c["unknown"]}  norev {c["norev"]}  미검수 {c["not_verified"]}  foreign {c["foreign"]}')
    if cls: print('     3.8 분류:', dict(cls))
