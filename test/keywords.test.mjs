import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function kw(prompt, patterns = []) {
  const out = execFileSync('python3', ['core/keywords.py', '--patterns', patterns.join(',')], { input: prompt });
  return JSON.parse(out); // { keywords: [...], lexicalTerms: [...] }
}

test('stopwords 제거 + 한국어 어간', () => {
  const r = kw('원오빌 문의 기반 정렬은 어떻게 동작하나요');
  assert.ok(r.keywords.includes('문의') || r.keywords.includes('정렬'));
  assert.ok(!r.keywords.includes('어떻게'));   // stopword
});

test('ep 패턴 off면 EP 용어 없음', () => {
  const r = kw('EP12 복선', []);
  assert.ok(!r.lexicalTerms.some(t => /EP0?12/.test(t)));
});

test('ep 패턴 on이면 EP 정규화 용어 생성', () => {
  const r = kw('EP12 복선', ['ep']);
  assert.ok(r.lexicalTerms.includes('EP012'));
  assert.ok(r.lexicalTerms.includes('EP12'));
});

test('keywords 상한 5', () => {
  const r = kw('하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열');
  assert.ok(r.keywords.length <= 5);
});
