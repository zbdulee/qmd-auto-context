"""읽기 전용: 카드 인구조사(§1/§2 갱신).

**3.8 백필 분류는 여기서 하지 않는다** — `scripts/wiki-revision-backfill.py --json` 이 SSOT다.
한때 이 파일에도 같은 판정이 있었고 두 벌이 갈렸다: 여기는 `git log -1 -- <path>` 의 시각을
봤는데 그것은 pathspec 이력 단순화로 merge 로 들어온 내용을 못 보므로, 백필 스크립트가
blob 대조로 올바르게 거부한 카드를 이 파일은 계속 후보로 보고했다. 판정을 두 곳에 두면
어느 쪽이 맞는지 알 수 없다.
"""
import sys, glob, json, collections
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

for name in PROJECTS:
    root = Path.home() / 'work' / name
    w, cfg = wiki_root(root)
    if w is None:
        print(f'{name}: wiki 없음 (indexing={cfg.get("indexing")})'); continue

    pending = WF.unresolved_pending_refreshes(root)
    pmap = {}
    for ev in pending:
        sp = ev.get('sourcePath')
        if isinstance(sp, str): pmap[sp] = ev

    c = collections.Counter()

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
            # provenance 결측 총량만 센다. 이 카드들이 어느 경로로 가야 하는지(백필 /
            # 재컴파일 / source-missing)의 판정은 `wiki-revision-backfill.py --json` 이
            # SSOT다 — 모듈 docstring 참고.
            c['norev'] += 1
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
