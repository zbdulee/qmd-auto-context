import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
test('pinned Laya raw adapter preserves class order, reviewed provenance and offline scoring',()=>{
 const out=execFileSync('python3',['test/fixtures/context-learning-laya-raw-checks.py'],{
  encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',QMD_RECALL_LOG:''}
 });
 assert.equal(out.trim(),'');
});
