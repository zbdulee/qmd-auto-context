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
    input: JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해', cwd: '/Users/example/work/sample' }),
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
      JSON.stringify({ prompt: '검색 결과 정렬은 어떻게 동작해?', cwd: tempDir }),
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

test('hierarchical recall queries wiki collections before raw backfill', async () => {
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
        const payload = JSON.parse(body);
        requests.push(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [
          { file: 'qmd://proj-wiki/.auto-context/wiki/decisions/config-layout.md', title: 'Config layout', score: 0.93 },
        ] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-hier-'));
  try {
    mkdirSync(join(tempDir, '.auto-context'), { recursive: true });
    writeFileSync(join(tempDir, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['proj-wiki', 'proj-docs'],
      collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
      recallStrategy: 'hierarchical',
      queryTimeout: 1.25,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: 'config layout decision 내용을 알려줘', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].collections, ['proj-wiki']);
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[wiki(?::generated)?\]/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Config layout/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hierarchical recall backfills raw collections when wiki has no results', async () => {
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
        const payload = JSON.parse(body);
        requests.push(payload);
        const isWiki = payload.collections.includes('proj-wiki');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: isWiki ? [] : [
          { file: 'qmd://proj-docs/docs/raw-source.md', title: 'Raw source', score: 0.88 },
        ] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-hier-raw-'));
  try {
    mkdirSync(join(tempDir, '.auto-context'), { recursive: true });
    writeFileSync(join(tempDir, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['proj-wiki', 'proj-docs'],
      collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
      recallStrategy: 'hierarchical',
      prefixStyle: 'tag',
      queryTimeout: 1.25,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: 'config layout 근거를 찾아줘', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].collections, ['proj-wiki']);
    assert.deepEqual(requests[1].collections, ['proj-docs']);
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[raw\]/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Raw source/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hierarchical recall does not duplicate raw backfill when raw also has no results', async () => {
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
        res.end(JSON.stringify({ results: [] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-hier-empty-'));
  try {
    mkdirSync(join(tempDir, '.auto-context'), { recursive: true });
    writeFileSync(join(tempDir, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['proj-wiki', 'proj-docs'],
      collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
      recallStrategy: 'hierarchical',
      queryTimeout: 1.25,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: 'config layout 근거를 찾아줘', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(out, '');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].collections, ['proj-wiki']);
    assert.deepEqual(requests[1].collections, ['proj-docs']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hierarchical recall backfills raw when wiki results are below minScore', async () => {
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
        const payload = JSON.parse(body);
        requests.push(payload);
        const isWiki = payload.collections.includes('proj-wiki');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: isWiki ? [
          { file: 'qmd://proj-wiki/.auto-context/wiki/decisions/stale.md', title: 'Weak wiki result', score: 0.1 },
        ] : [
          { file: 'qmd://proj-docs/docs/raw-source.md', title: 'Raw source', score: 0.88 },
        ] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-hier-low-'));
  try {
    mkdirSync(join(tempDir, '.auto-context'), { recursive: true });
    writeFileSync(join(tempDir, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['proj-wiki', 'proj-docs'],
      collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
      recallStrategy: 'hierarchical',
      minScore: 0.5,
      queryTimeout: 1.25,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: 'config layout 근거를 찾아줘', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].collections, ['proj-wiki']);
    assert.deepEqual(requests[1].collections, ['proj-docs']);
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[raw\]/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Raw source/);
    assert.doesNotMatch(parsed.hookSpecificOutput.additionalContext, /Weak wiki result/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hierarchical recall applies rawFallbackMinScore to raw backfill results', async () => {
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
        const payload = JSON.parse(body);
        requests.push(payload);
        const isWiki = payload.collections.includes('proj-wiki');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: isWiki ? [] : [
          { file: 'qmd://proj-docs/docs/weak-raw.md', title: 'Weak raw source', score: 0.65 },
        ] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-hier-raw-threshold-'));
  try {
    mkdirSync(join(tempDir, '.auto-context'), { recursive: true });
    writeFileSync(join(tempDir, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['proj-wiki', 'proj-docs'],
      collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
      recallStrategy: 'hierarchical',
      minScore: 0.5,
      rawFallbackMinScore: 0.7,
      queryTimeout: 1.25,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: 'config layout 근거를 찾아줘', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].collections, ['proj-wiki']);
    assert.deepEqual(requests[1].collections, ['proj-docs']);
    assert.equal(out, '');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('hierarchical recall can relax raw fallback below the wiki minScore', async () => {
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
        const payload = JSON.parse(body);
        requests.push(payload);
        const isWiki = payload.collections.includes('proj-wiki');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: isWiki ? [] : [
          { file: 'qmd://proj-docs/docs/raw-source.md', title: 'Relaxed raw source', score: 0.65 },
        ] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tempDir = mkdtempSync(join(process.cwd(), '.tmp-qmd-http-hier-raw-relaxed-'));
  try {
    mkdirSync(join(tempDir, '.auto-context'), { recursive: true });
    writeFileSync(join(tempDir, '.auto-context', 'settings.json'), JSON.stringify({
      indexing: true,
      collections: ['proj-wiki', 'proj-docs'],
      collectionRoles: { 'proj-wiki': 'wiki', 'proj-docs': 'raw' },
      recallStrategy: 'hierarchical',
      minScore: 0.7,
      rawFallbackMinScore: 0,
      queryTimeout: 1.25,
    }));

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const out = await runRecallAsync(
      JSON.stringify({ prompt: 'config layout 근거를 찾아줘', cwd: tempDir }),
      { ...process.env, QMD_DAEMON_URL: `http://127.0.0.1:${port}` },
    );

    assert.equal(requests.length, 2);
    const parsed = JSON.parse(out);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[raw\]/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /Relaxed raw source/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('디스패처가 잘못된 stdin에도 graceful(크래시 없음)', () => {
  const out = execFileSync('bash', ['hooks/run-hook', 'recall', 'claude'], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.cwd() },
  });
  assert.equal(typeof out, 'string', '크래시 없이 종료');
});
