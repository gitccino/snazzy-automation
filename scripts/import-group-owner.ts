import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectImportGroup } from '../src/db/import-owner-inspection';

const target = process.argv[2];
if (!['local', 'staging', 'production'].includes(target ?? '') || process.argv.length !== 3) throw new Error('Usage: tsx scripts/import-group-owner.ts local|staging|production < input.json');
const raw = await new Promise<string>((resolve, reject) => {
  let data = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; if (data.length > 8192) reject(new Error('input too long')); });
  process.stdin.on('end', () => resolve(data)); process.stdin.on('error', reject);
});
let input: any;
try { input = JSON.parse(raw); } catch { throw new Error('invalid input JSON'); }
const valid = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !v.includes('\0');
if (!input || typeof input !== 'object' || !valid(input.runId) || !valid(input.ownerGroupId) || !valid(input.groupId)) throw new Error('runId, ownerGroupId and groupId required');
const directory = mkdtempSync(join(tmpdir(), 'import-owner-'));
try {
  const db = { prepare(sql: string) { return { bind(...values: string[]) { return { async all() {
    let i = 0;
    const bound = sql.replace(/\?/g, () => "'" + values[i++]!.replaceAll("'", "''") + "'");
    if (i !== values.length) throw new Error('parameter mismatch');
    const file = join(directory, 'query.sql'); writeFileSync(file, bound, {mode:0o600});
    const args = ['wrangler', 'd1', 'execute', `snazzy-automation-${target}`, target === 'local' ? '--local' : '--remote', '--json', '--file', file];
    if (target !== 'local') args.push('--env', target!);
    return JSON.parse(execFileSync('npx', args, {encoding:'utf8', stdio:['ignore','pipe','pipe']}))[0];
  } }; } }; } } as unknown as D1Database;
  const result = await inspectImportGroup(db, input.runId, input.ownerGroupId, input.groupId);
  console.log(JSON.stringify({target, result}, null, 2));
  if (!result) process.exitCode = 1;
} catch {
  console.error('D1 operation failed; check target, authentication, migrations and input privately.'); process.exitCode = 1;
} finally { rmSync(directory, {recursive:true, force:true}); }
