import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
test('reviewed dataset CLI exports reproducibly and scores held-out supplied predictions offline',()=>{
 const out=execFileSync('python3',['test/fixtures/context-learning-dataset-checks.py'],{
  encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',QMD_RECALL_LOG:''}
 });
 assert.equal(out.trim(),'');
});
