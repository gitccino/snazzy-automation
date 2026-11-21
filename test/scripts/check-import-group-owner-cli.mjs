import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('owner CLI repairs only the matching local D1 notice and holds replay and conflicts', () => {
  const root=resolve('.'), dir=mkdtempSync(join(tmpdir(),'owner-cli-test-'));
  const run='run_cli', group='owner_cli', key=JSON.stringify(['import',run,1,1,'terminal']);
  const context=JSON.stringify({replyGroupId:group,settings:{config:{airtableBaseId:'base',airtableProductsTableId:'table'}}});
  const outcome=JSON.stringify({stage:'settings-context',failureCode:'setup_failed',eventId:'event',resultKey:key,action:'verify',outcome:'unconfirmed',references:{notice:'early_setup'}});
  const quote=x=>`'${x.replaceAll("'","''")}'`;
  const command=(args)=>execFileSync(join(root,'node_modules/.bin/wrangler'),args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    symlinkSync(join(root,'migrations'),join(dir,'migrations'));
    symlinkSync(join(root,'node_modules'),join(dir,'node_modules'));
    writeFileSync(join(dir,'wrangler.jsonc'),JSON.stringify({name:'owner-test',compatibility_date:'2026-09-01',d1_databases:[{binding:'DB',database_name:'snazzy-automation-local',database_id:'00000000-0000-0000-0000-000000000001',migrations_dir:'migrations'}]}));
    command(['d1','migrations','apply','snazzy-automation-local','--local']);
    const sql=`INSERT INTO import_runs(id,source_album_id,trigger,status,started_at,settings_context_json) VALUES(${quote(run)},'album','line','start_failed','2026-11-20T00:00:00Z',${quote(context)}); INSERT INTO line_command_ingress VALUES('event',${quote(group)},'{"type":"upload"}',${quote(run)},'now'); INSERT INTO workflow_feedback(kind,run_id,generation,notification_cycle,group_id,context_json,stage,event_id,failure_code) VALUES('import',${quote(run)},1,1,${quote(group)},${quote(context)},'settings-context','event','setup_failed'); INSERT INTO workflow_feedback_results(kind,run_id,generation,notification_cycle,revision,result_key,outcome_json,group_id) VALUES('import',${quote(run)},1,1,0,${quote(key)},${quote(outcome)},${quote(group)});`;
    writeFileSync(join(dir,'seed.sql'),sql);
    command(['d1','execute','snazzy-automation-local','--local','--file',join(dir,'seed.sql')]);
    const input={runId:run,ownerGroupId:group,baseId:'base',tableId:'table',actor:'operator',reason:'reviewed'};
    const inspect=(value)=>spawnSync(join(root,'node_modules/.bin/tsx'),[join(root,'scripts/import-group-owner.ts'),'local','inspect-run'],{cwd:dir,input:JSON.stringify(value),encoding:'utf8'});
    const inspected=inspect({...input,kind:'import'}); assert.equal(inspected.status,0,inspected.stderr); assert.equal(JSON.parse(inspected.stdout).result.feedback.failureCode,'setup_failed');
    assert.equal(inspect({...input,kind:'import',ownerGroupId:'foreign'}).status,1);
    const pubContext=JSON.stringify({replyGroupId:group,settings:{config:{airtableBaseId:'base',airtablePublicationRunsTableId:'runs',googleDriveFolderId:'folder'}}});
    writeFileSync(join(dir,'publication.sql'),`INSERT INTO publication_jobs(publication_run_id,state,correlation_id,created_at,updated_at,settings_context_json,generation,notification_cycle) VALUES('pub_cli','failed','workflow','now','now',${quote(pubContext)},2,3);`);
    command(['d1','execute','snazzy-automation-local','--local','--file',join(dir,'publication.sql')]);
    const publication=inspect({kind:'publication',runId:'pub_cli',ownerGroupId:group,baseId:'base',tableId:'runs',generation:2,notificationCycle:3});
    assert.equal(publication.status,0,publication.stderr); assert.equal(JSON.parse(publication.stdout).result.execution.notificationCycle,3);


    const cli=(value)=>spawnSync(join(root,'node_modules/.bin/tsx'),[join(root,'scripts/import-group-owner.ts'),'local','repair-notice'],{cwd:dir,input:JSON.stringify(value),encoding:'utf8'});
    assert.equal(cli({...input,baseId:'wrong'}).status,1);
    assert.equal(cli({...input,ownerGroupId:'other'}).status,1);
    const success=cli(input); assert.equal(success.status,0,success.stderr + success.stdout); assert.equal(JSON.parse(success.stdout).result,true);
    assert.equal(cli(input).status,1);
    const rows=JSON.parse(command(['d1','execute','snazzy-automation-local','--local','--json','--command',`SELECT (SELECT count(*) FROM import_owner_notice_repairs) AS audits,(SELECT count(*) FROM line_result_outbox) AS notices,(SELECT materialized FROM workflow_feedback_results) AS materialized`]))[0].results[0];
    assert.deepEqual(rows,{audits:1,notices:1,materialized:1});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
