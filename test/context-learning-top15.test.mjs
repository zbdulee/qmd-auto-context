import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
test('Top15 shadow expansion preserves hook bytes and bounded versioned evidence',()=>{
 const out=execFileSync('python3',['test/fixtures/context-learning-top15-checks.py'],{
  encoding:'utf8',timeout:25000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',QMD_RECALL_LOG:'',QMD_LIVE:''}
 });
 assert.equal(out.trim(),'');
});
