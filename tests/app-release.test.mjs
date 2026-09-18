import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEntry,verifyReport} from '../scripts/gitlab-app-publish.mjs';
const entry={platform:'linux',version:'1.2.3',name:'Synora-1.2.3-linux-amd64.deb',source:'a'.repeat(40),sha256:'b'.repeat(64),evidenceSha256:'c'.repeat(64),size:10,notes:'Notes',description:'App',qualification:'passed'};
test('release entry binds platform, version, digest, source and qualification',()=>{
 validateEntry(entry,'linux');
 for(const changed of [{name:'../file'},{qualification:'failed'},{sha256:'bad'},{version:'1.2.3-preview'},{size:0}])assert.throws(()=>validateEntry({...entry,...changed},'linux'));
});
test('native qualification rejects failure, skip, flaky or empty report',()=>{
 const report={errors:[],stats:{expected:1,unexpected:0,skipped:0,flaky:0}};
 verifyReport(report,'linux','1.2.3');
 for(const stats of [{expected:0},{unexpected:1},{skipped:1},{flaky:1}])assert.throws(()=>verifyReport({...report,stats:{...report.stats,...stats}},'linux','1.2.3'));
 assert.throws(()=>verifyReport({...report,errors:['failure']},'linux','1.2.3'));
});
test('web qualification binds package version and functional checks',()=>{
 const report={version:'1.2.3',status:'PASS',manifestFiles:750,checks:['a','b','c','d','e','f']};
 verifyReport(report,'web','1.2.3');
 assert.throws(()=>verifyReport(report,'web','1.2.4'));
 assert.throws(()=>verifyReport({...report,status:'FAIL'},'web','1.2.3'));
});
