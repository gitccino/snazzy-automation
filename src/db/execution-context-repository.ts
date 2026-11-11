import { z } from 'zod';
import type { OperationContext } from '../settings/schema';

const id = z.string().trim().min(1);
const retry = z.union([z.literal(0), z.literal(5)]);
const contextSchema = z.strictObject({
  settings: z.strictObject({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), config: z.strictObject({
    timeZone: z.literal('Asia/Bangkok'), productIdPrefix: z.literal('A'), claudeModel: z.literal('claude-opus-5'), publicBaseUrl: z.url(),
    airtableBaseId: id, airtableProductsTableId: id, airtablePublicationRunsTableId: id, googleDriveFolderId: id, googleTemplateDocId: id,
    lineAllowedGroupIds: z.array(id).min(1), soldoutConfirmationEnabled: z.boolean(), firstImportCutoffDate: z.iso.datetime().nullable(),
    importRetryLimit: retry, publicationRetryLimit: retry, aiCaptionsEnabled: z.boolean(), productIdInitialNumber: z.number().int().positive(),
    claudeRequestInputTokenLimit: z.number().int().positive().max(150000), monthlyBudgetThb: z.number().finite().positive(), usdToThbRate: z.number().finite().positive(),
    claudeInputPriceUsdPerMtok: z.number().finite().nonnegative(), claudeOutputPriceUsdPerMtok: z.number().finite().nonnegative(), r2PriceUsdPerGbMonth: z.number().finite().nonnegative(),
  }) }), replyGroupId: id.nullable(),
});
export function parseContext(json: string | null): OperationContext | null { return json === null ? null : contextSchema.parse(JSON.parse(json)); }
export function serializeContext(context: OperationContext): string { return JSON.stringify(contextSchema.parse(context)); }
export async function readImportContext(db: D1Database, runId: string): Promise<OperationContext | null> {
  const row = await db.prepare('SELECT settings_context_json FROM import_runs WHERE id = ?').bind(runId).first<{ settings_context_json: string | null }>();
  return row ? parseContext(row.settings_context_json) : null;
}
export async function readPublicationContext(db: D1Database, runId: string): Promise<OperationContext | null> {
  const row = await db.prepare('SELECT settings_context_json FROM publication_jobs WHERE publication_run_id = ?').bind(runId).first<{ settings_context_json: string | null }>();
  return row ? parseContext(row.settings_context_json) : null;
}
export async function readPendingContext(db: D1Database, token: string): Promise<OperationContext | null> {
  const row = await db.prepare('SELECT settings_context_json FROM pending_line_commands WHERE token = ?').bind(token).first<{ settings_context_json: string | null }>();
  return row ? parseContext(row.settings_context_json) : null;
}
export async function saveImportContextIfAbsent(db: D1Database, runId: string, context: OperationContext): Promise<OperationContext> {
  const serialized = serializeContext(context);
  await db.prepare("UPDATE import_runs SET settings_context_json = ? WHERE id = ? AND status = 'running' AND settings_context_json IS NULL").bind(serialized, runId).run();
  const saved = await readImportContext(db, runId);
  if (!saved) throw new Error('import_context_unavailable');
  return saved;
}
