import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// macOS는 /usr/bin/python3 로 3.9 를 탑재한다. 훅은 bare `python3` 를 실행하므로
// (hooks/run-hook, core/update.sh) 사용자의 PATH 가 시스템 python 을 가리키면
// 그 인터프리터가 곧 런타임이다. PEP 604(`X | None`)는 3.10+ 문법이고 annotation 은
// 정의 시점에 평가되므로, future import 없이 쓰면 **모듈 import 자체가 TypeError** 로
// 죽는다 → 훅이 exit 1(=host "hook failed") 로 표면화되고 플러그인이 통째로 무동작한다.
// 실측: 이 가드가 없던 시점 시스템 python 3.9 에서 764 중 365 실패(3.13 은 0 실패).
// 로컬 python 버전과 무관하게 성립하도록 ast 로 annotation 위치의 `|` 만 검사한다.
const DETECT = String.raw`
import ast, json, pathlib, sys

def ann_nodes(tree):
    """annotation 으로 평가되는 위치만 모은다(문자열 리터럴·런타임 표현식 제외)."""
    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and node.annotation is not None:
            yield node.annotation
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
            yield node.returns
        elif isinstance(node, ast.AnnAssign) and node.annotation is not None:
            yield node.annotation

def has_bitor(node):
    return any(isinstance(n, ast.BinOp) and isinstance(n.op, ast.BitOr) for n in ast.walk(node))

SKIP_PARTS = {'node_modules', '.git', '.worktrees', '__pycache__'}

def shipped_py(root):
    """저장소의 모든 .py — core/ 최상위만이 아니다.

    처음엔 core/ 최상위만 비재귀로 훑어 **배포되는 13개 파일이 가드 밖**이었다:
    core/extractors/(host CLI adapter 4개 + __init__), hermes_adapter/(플러그인
    진입점 3개), root __init__.py, test/helpers/. 그 중 어디에 PEP 604 가 들어가도
    시스템 python 3.9 에서 import 가 죽는데 테스트가 잡지 못했다 — 이 가드가 막으려는
    바로 그 클래스다(발견 시점 실제 위험은 0건이었으므로 구멍이지 결함은 아니었다).

    주의: 이 문자열은 JS String.raw 템플릿 안에 있다 — 백틱을 쓰면 리터럴이 조기
    종료돼 테스트 파일 자체가 로드에 실패한다(실제로 한 번 그랬다).
    """
    for p in sorted(pathlib.Path(root).rglob('*.py')):
        if any(part in SKIP_PARTS or part.startswith('.tmp-') for part in p.parts):
            continue
        yield p

offenders = []
for p in shipped_py(sys.argv[1]):
    src = p.read_text(encoding='utf-8')
    tree = ast.parse(src)
    future = any(
        isinstance(n, ast.ImportFrom) and n.module == '__future__'
        and any(a.name == 'annotations' for a in n.names)
        for n in tree.body
    )
    if future:
        continue
    hits = sum(1 for a in ann_nodes(tree) if has_bitor(a))
    if hits:
        offenders.append({'module': p.name, 'pep604_annotations': hits})

print(json.dumps(offenders, ensure_ascii=False))
`;

test('CRITICAL: 배포되는 모든 python 모듈은 PEP 604 annotation 을 쓰면 future import 를 갖는다 (시스템 python 3.9 에서 훅이 죽지 않게)', () => {
  const out = execFileSync('python3', ['-c', DETECT, ROOT], { encoding: 'utf8' });
  const offenders = JSON.parse(out);
  assert.deepStrictEqual(
    offenders, [],
    `PEP 604(\`X | None\`) annotation 을 쓰면서 \`from __future__ import annotations\` 가 없는 core 모듈: ` +
    `${JSON.stringify(offenders)}. 이 모듈은 python 3.9(macOS 기본)에서 import 가 TypeError 로 죽고, ` +
    `bare python3 로 실행되는 훅이 exit 1 이 된다. 파일 선두(shebang/docstring 다음)에 future import 를 추가하라.`
  );
});

test('배포되는 모든 python 모듈은 python 3.9 를 하한으로 파싱된다 (3.10+ 전용 구문 금지)', () => {
  // match 문(3.10)·except*(3.11) 등 future import 로 구제되지 않는 구문을 차단한다.
  const script = String.raw`
import ast, json, pathlib, sys
SKIP_PARTS = {'node_modules', '.git', '.worktrees', '__pycache__'}
def shipped_py(root):
    for q in sorted(pathlib.Path(root).rglob('*.py')):
        if any(x in SKIP_PARTS or x.startswith('.tmp-') for x in q.parts): continue
        yield q
bad = []
for p in shipped_py(sys.argv[1]):
    tree = ast.parse(p.read_text(encoding='utf-8'))
    for n in ast.walk(tree):
        if type(n).__name__ in ('Match', 'TryStar'):
            bad.append({'module': p.name, 'node': type(n).__name__})
print(json.dumps(bad, ensure_ascii=False))
`;
  const bad = JSON.parse(execFileSync('python3', ['-c', script, ROOT], { encoding: 'utf8' }));
  assert.deepStrictEqual(
    bad, [],
    `python 3.10+ 전용 구문을 쓰는 모듈: ${JSON.stringify(bad)}. ` +
    `future import 로는 구제되지 않으므로 3.9 호환 구문으로 바꿔라.`
  );
});
