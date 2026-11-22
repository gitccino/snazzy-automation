import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLineReplyRepository } from '../src/db/line-reply-repository';

// Wrangler has no parameter binding on its CLI; quote values before writing a private SQL file.
function literal(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid input');
  return "'" + value.replaceAll("'", "''") + "'";
}
const target = process.argv[2];
if (!['local', 'staging', 'production'].includes(target ?? '') || process.argv.length !== 3) throw new Error('Usage: tsx scripts/line-reply-owner.ts local|staging|production < input.json');
const input = JSON.parse(await new Promise<string>((resolve, reject) => {
  let data = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; if (data.length > 8192) reject(new Error('input too long')); });
  process.stdin.on('end', () => resolve(data)); process.stdin.on('error', reject);
}));
const valid = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !v.includes('\0');
if (!valid(input.groupId) || !valid(input.eventId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('groupId, eventId and positive sequence required');
if (input.decision !== undefined && (!['confirmed_acceptance', 'close_unverifiable'].includes(input.decision) || !valid(input.actor) || !valid(input.reason))) throw new Error('invalid decision, actor or reason');
const directory = mkdtempSync(join(tmpdir(), 'line-owner-'));
function execute(sql: string, values: unknown[] = []) {
  let i = 0;
  const bound = sql.replace(/\?/g, () => literal(values[i++]));
  if (i !== values.length) throw new Error('parameter mismatch');
  const file = join(directory, 'query.sql'); writeFileSync(file, bound, { mode: 0o600 });
  const args = ['wrangler', 'd1', 'execute', `snazzy-automation-${target}`, target === 'local' ? '--local' : '--remote', '--json', '--file', file];
  if (target !== 'local') args.push('--env', target!);
  const output = execFileSync('npx', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(output)[0];
}
try {
  const inspect = () => execute(`SELECT o.sequence,o.result_key,o.group_id,o.state,o.owner_event_id,o.created_at,
    d.event_id,d.workflow_id,d.phase,d.updated_at,d.request_id,d.http_status,d.disposition,
    x.decision,x.actor,x.reason,x.created_at AS closed_at
    FROM line_result_outbox o LEFT JOIN line_reply_dispatches d ON d.event_id=o.owner_event_id
    LEFT JOIN line_reply_owner_dispositions x ON x.sequence=o.sequence
    WHERE o.group_id=? AND o.sequence=? AND d.event_id=?`, [input.groupId, input.sequence, input.eventId]).results;
  console.log(JSON.stringify({ target, rows: inspect() }, null, 2));
  if (input.decision !== undefined) {
    const db = { prepare(sql: string) { return { bind(...values: unknown[]) { return { async run() { const result = execute(sql + " RETURNING sequence", values); return { meta: { changes: result.results.length } }; } }; } }; } } as unknown as D1Database;
    const repo = createLineReplyRepository(db, { now: () => new Date() });
    const recorded = await repo.recordOwnerDisposition(input);
    console.log(JSON.stringify({ recorded, rows: inspect() }, null, 2));
    if (!recorded) process.exitCode = 1;
  }
} catch {
  console.error('D1 operation failed; check target, authentication, migrations and input privately.'); process.exitCode = 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
