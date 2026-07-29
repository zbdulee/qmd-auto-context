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

offenders = []
for p in sorted(pathlib.Path(sys.argv[1], 'core').glob('*.py')):
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

test('CRITICAL: core 모듈은 PEP 604 annotation 을 쓰면 future import 를 갖는다 (시스템 python 3.9 에서 훅이 죽지 않게)', () => {
  const out = execFileSync('python3', ['-c', DETECT, ROOT], { encoding: 'utf8' });
  const offenders = JSON.parse(out);
  assert.deepStrictEqual(
    offenders, [],
    `PEP 604(\`X | None\`) annotation 을 쓰면서 \`from __future__ import annotations\` 가 없는 core 모듈: ` +
    `${JSON.stringify(offenders)}. 이 모듈은 python 3.9(macOS 기본)에서 import 가 TypeError 로 죽고, ` +
    `bare python3 로 실행되는 훅이 exit 1 이 된다. 파일 선두(shebang/docstring 다음)에 future import 를 추가하라.`
  );
});

test('core 모듈은 python 3.9 를 하한으로 파싱된다 (3.10+ 전용 구문 금지)', () => {
  // match 문(3.10)·except*(3.11) 등 future import 로 구제되지 않는 구문을 차단한다.
  const script = String.raw`
import ast, json, pathlib, sys
bad = []
for p in sorted(pathlib.Path(sys.argv[1], 'core').glob('*.py')):
    tree = ast.parse(p.read_text(encoding='utf-8'))
    for n in ast.walk(tree):
        if type(n).__name__ in ('Match', 'TryStar'):
            bad.append({'module': p.name, 'node': type(n).__name__})
print(json.dumps(bad, ensure_ascii=False))
`;
  const bad = JSON.parse(execFileSync('python3', ['-c', script, ROOT], { encoding: 'utf8' }));
  assert.deepStrictEqual(
    bad, [],
    `python 3.10+ 전용 구문을 쓰는 core 모듈: ${JSON.stringify(bad)}. ` +
    `future import 로는 구제되지 않으므로 3.9 호환 구문으로 바꿔라.`
  );
});
