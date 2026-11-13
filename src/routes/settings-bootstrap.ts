import { parseConfig } from '../config';
import { initializeSettings, readSettings } from '../db/settings-repository';
import type { Env } from '../env';
import { parseStoredSettings } from '../settings/schema';
import { verifyAdminBearer } from '../shared/admin-auth';

export async function handleSettingsBootstrap(request: Request, env: Env): Promise<Response> {
  if (!await verifyAdminBearer(request, env.ADMIN_ROUTE_TOKEN)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    let record = await readSettings(env.DB);
    let publicBaseUrl: string | undefined;
    if (!record) {
      const config = parseConfig(env.APP_CONFIG_JSON, env.WORKFLOW_RETRY_LIMIT);
      const origin = new URL(config.publicBaseUrl);
      if (origin.username || origin.password || origin.protocol !== 'https:') throw new Error('Invalid public origin');
      publicBaseUrl = config.publicBaseUrl;
      if (config.productIdPrefix !== 'A') throw new Error('Unsupported product prefix');
      const settings = parseStoredSettings({
        AIRTABLE_BASE_ID: config.airtableBaseId, AIRTABLE_PRODUCTS_TABLE_ID: config.airtableProductsTableId,
        AIRTABLE_PUBLICATION_RUNS_TABLE_ID: config.airtablePublicationRunsTableId,
        GOOGLE_DRIVE_FOLDER_ID: config.googleDriveFolderId, GOOGLE_TEMPLATE_DOC_ID: config.googleTemplateDocId,
        LINE_ALLOWED_GROUP_IDS: [config.lineAllowedGroupId], SOLDOUT_CONFIRMATION_ENABLED: config.soldoutConfirmationEnabled,
        FIRST_IMPORT_CUTOFF_DATE: config.firstImportCutoffDate, IMPORT_RETRY_LIMIT: config.importRetryLimit,
        PUBLICATION_RETRY_LIMIT: config.publicationRetryLimit, AI_CAPTIONS_ENABLED: config.aiCaptionsEnabled, CLAUDE_MODEL: config.claudeModel,
        PRODUCT_ID_INITIAL_NUMBER: config.productIdInitialNumber, CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: config.claudeRequestInputTokenLimit,
        MONTHLY_BUDGET_THB: config.monthlyBudgetThb, USD_TO_THB_RATE: config.usdToThbRate,
        CLAUDE_INPUT_PRICE_USD_PER_MTOK: config.claudeInputPriceUsdPerMtok, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: config.claudeOutputPriceUsdPerMtok,
        R2_PRICE_USD_PER_GB_MONTH: config.r2PriceUsdPerGbMonth,
      });
      record = await initializeSettings(env.DB, settings, new Date().toISOString());
    }
    return Response.json({ revision: record.revision, schemaVersion: record.schemaVersion, ...(publicBaseUrl ? { publicBaseUrl } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'settings_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
