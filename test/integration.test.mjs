// 데몬 라이브 통합 스모크 — QMD_LIVE=1 일 때만. 평소엔 skip(결정적 단위테스트가 본체).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('라이브 데몬 recall 스모크', { skip: !process.env.QMD_LIVE }, () => {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬', cwd: '/Users/dulee/work/axiom' }),
    encoding: 'utf8',
  });
  // 데몬 결과 유무와 무관하게 크래시 없이 종료(빈 출력 또는 JSON)
  assert.ok(out === '' || out.includes('additionalContext'));
});

test('어댑터 wrapper가 잘못된 stdin에도 graceful(크래시 없음)', () => {
  const out = execFileSync('python3', ['adapters/claude/wrapper.py', 'recall'], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(out.trim(), '');
});
