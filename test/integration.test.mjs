import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function runRecallAsync(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['core/recall.py'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`recall.py exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}

test('라이브 데몬 recall 스모크', { skip: !process.env.QMD_LIVE }, () => {
  const out = execFileSync('python3', ['core/recall.py'], {
    input: JSON.stringify({ prompt: '원오빌 문의 기반 정렬', cwd: '/Users/dulee/work/axiom' }),
    encoding: 'utf8',
  });
  assert.ok(out.includes('additionalContext'));
});

test('mock HTTP daemon recall integration validates query payload and context output', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/query') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [
            { file: 'qmd://mock/docs/oneobil.md', title: 'Oneobil sorting', score: 0.91 },
          ],
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-integration-'));
  try {
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    writeFileSync(join(tempDir, '.agents', 'qmd-recall.json'), JSON.stringify({
      collections: ['mock'],
      queryTimeout: 1.25,
      topN: 1,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: '원오빌 문의 기반 정렬 어떻게 동작해?', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].collections, ['mock']);
    assert.deepEqual(requests[0].searches.map(s => s.type), ['lex', 'vec']);
    assert.equal(requests[0].timeout, 1.25);
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Oneobil sorting/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('어댑터 wrapper가 잘못된 stdin에도 graceful(크래시 없음)', () => {
  const out = execFileSync('python3', ['adapters/claude/wrapper.py', 'recall'], {
    input: 'not json',
    encoding: 'utf8',
  });
  assert.equal(out.trim(), '');
});
