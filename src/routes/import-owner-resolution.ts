import { z } from 'zod';
import type { Env } from '../env';
import { verifyAdminBearer } from '../shared/admin-auth';
import { verifyHistoricalImportEvidence } from '../import/owner-evidence';
import { resolveHistoricalImportGroup } from '../db/import-owner-resolution';
import { renderAirtablePreview } from '../import/preview';

const field = z.string().trim().min(1).max(500).refine(v => !v.includes('\0'));
const requestSchema = z.object({runId:field, groupId:field, ownerGroupId:field, baseId:field, tableId:field, recordId:field, actor:field, reason:field, apply:z.literal(true)}).strict();
const recordSchema = z.object({fields:z.object({
  'Product ID':z.string().min(1), 'System Group ID':z.string().min(1),
  'Product Images':z.array(z.object({id:z.string().min(1), filename:z.string(), url:z.string(), size:z.number().optional()})),
})});

export async function handleImportOwnerResolution(request:Request, env:Env):Promise<Response> {
  if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) return Response.json({error:'unauthorized'}, {status:401});
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({error:'invalid_request'}, {status:400});
  const input = parsed.data;
  const evidence = await verifyHistoricalImportEvidence({
    db:env.DB,
    readOriginal:async key => (await env.IMAGES_BUCKET.get(key))?.arrayBuffer() ?? null,
    renderPreview:async bytes => (await renderAirtablePreview(env.IMAGES, new Blob([bytes]).stream())).arrayBuffer(),
    readRecord:async ({baseId,tableId,recordId}) => {
      const response = await fetch(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`, {headers:{Authorization:`Bearer ${env.AIRTABLE_TOKEN}`}});
      if (!response.ok) throw new Error('provider unavailable');
      const {fields} = recordSchema.parse(await response.json());
      return {productId:fields['Product ID'],groupHash:fields['System Group ID'],attachments:fields['Product Images']};
    },
    fetcher:fetch.bind(globalThis),
  }, input);
  if (evidence.status === 'held') return Response.json(evidence, {status:409, headers:{'Cache-Control':'no-store'}});
  const result = await resolveHistoricalImportGroup(env.DB, {...input,evidence});
  return Response.json(result ? {status:'resolved'} : {status:'held',reason:'evidence_changed'}, {status:result ? 200 : 409, headers:{'Cache-Control':'no-store'}});
}
