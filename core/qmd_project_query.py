"""Bounded local QMD query against an explicitly selected project index."""
from __future__ import annotations

import json
import os
import subprocess
import qmd_route


def _binary():
    return qmd_route.binary_info()['QMD_BIN']


def query(selected, searches, collections, limit, *, timeout):
    """Return QMD JSON rows, or None on a bounded CLI failure."""
    if not isinstance(selected,dict) or not all(selected.get(k) for k in
            ('INDEX_PATH','QMD_CONFIG_DIR','XDG_CACHE_HOME')):
        raise ValueError('project_index_not_selected')
    if not collections or not isinstance(limit,int) or limit<1:
        return []
    lines=[]
    for item in searches:
        kind=item.get('type')
        if kind not in ('lex','vec'):continue
        value=' '.join(str(item.get('query','')).split()).replace('"','')
        if value:lines.append(f'{kind}: {value}')
    if not lines:return []
    command=[_binary(),'query','\n'.join(lines),'-n',str(min(limit,100)),
             '--format','json','--no-rerank']
    for name in collections:
        if not isinstance(name,str) or not name or name.startswith('-'):
            raise ValueError('unsafe_collection_name')
        command.extend(['-c',name])
    env={**os.environ,**{k:selected[k] for k in
        ('INDEX_PATH','QMD_CONFIG_DIR','XDG_CACHE_HOME')},
        'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1'}
    try:
        result=subprocess.run(command,env=env,stdin=subprocess.DEVNULL,
            capture_output=True,text=True,timeout=max(0.1,float(timeout)),check=False)
        if result.returncode or len(result.stdout)>2_000_000:return None
        rows=json.loads(result.stdout)
        return rows[:limit] if isinstance(rows,list) else None
    except (OSError,ValueError,subprocess.TimeoutExpired,json.JSONDecodeError):
        return None
