import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
// Internal GitLab, TLS verified against its CA obtained through trusted PVE.
// Large installers do not cross Cloudflare's request size/time limits.
export async function transfer(method,url,file,token=process.env.CI_JOB_TOKEN,header='JOB-TOKEN') {
  assert.ok(url.startsWith('https://gitlab.synapsecorp.org/api/v4/projects/20/packages/generic/synora-app/'));
  assert.ok(token&&!/[\r\n"\\]/.test(token));
  assert.ok(['GET','PUT','HEAD'].includes(method));
  assert.ok(['JOB-TOKEN','PRIVATE-TOKEN'].includes(header));
  const args=['--config','-','--silent','--show-error','--fail','--proto','=https','--resolve','gitlab.synapsecorp.org:443:10.0.20.7','--cacert','.gitlab/origin-ca.crt','--connect-timeout','15','--max-time','900',url];
  if(method==='PUT')args.push('--upload-file',file);
  else if(method==='GET')args.push('--output',file);
  else args.push('--head');
  await new Promise((resolve,reject)=>{
    const p=spawn('curl',args,{stdio:['pipe','ignore','pipe']});let error='';
    p.stderr.on('data',b=>{if(error.length<2000)error+=b;});
    p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error(`Internal package transfer failed (${code}): ${error}`)));
    p.stdin.on('error',reject);p.stdin.end(`header = "${header}: ${token}"\n`);
  });
}
