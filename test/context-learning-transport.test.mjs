import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
test('bounded opt-in teacher transport uses mock CLIs and stores provisional labels atomically',()=>{
 const out=execFileSync('python3',['test/fixtures/context-learning-transport-checks.py'],{encoding:'utf8',timeout:30000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(out.trim(),'');
});
