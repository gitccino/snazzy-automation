import { resolveAlbum, type Album, type AlbumLookup } from '../line/album-lookup';
import type { InventoryProduct } from '../line/types';

export async function lookupProductAlbum(
  db: D1Database,
  target: {baseId:string; tableId:string},
  product: Pick<InventoryProduct,'productId'|'recordId'|'uploadDate'>,
  registry: Album[],
): Promise<AlbumLookup> {
  try {
    const rows = await db.prepare(`SELECT DISTINCT r.source_album_id FROM product_groups g
      JOIN import_runs r ON r.id=g.import_run_id
      WHERE g.product_id=? AND g.airtable_record_id=?
        AND CASE WHEN json_valid(r.settings_context_json) THEN
          json_extract(r.settings_context_json,'$.settings.config.airtableBaseId') END = ?
        AND CASE WHEN json_valid(r.settings_context_json) THEN
          json_extract(r.settings_context_json,'$.settings.config.airtableProductsTableId') END = ?
      LIMIT 3`).bind(product.productId,product.recordId,target.baseId,target.tableId).all<{source_album_id:string}>();
    return resolveAlbum(registry,rows.results.length ? rows.results.map(r=>r.source_album_id) : null,product.uploadDate);
  } catch {
    // Optional enrichment must never suppress inventory or guess after a failed read.
    return {status:'unavailable'};
  }
}
