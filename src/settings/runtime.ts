import { z } from 'zod';
import { parseConfig } from '../config';
import { readSettings } from '../db/settings-repository';
import type { Env } from '../env';
import type { RuntimeSettings, SettingsSnapshot, StoredSettings } from './schema';

export function toRuntimeSettings(s: StoredSettings, publicBaseUrl: string): RuntimeSettings {
  return {
    timeZone: 'Asia/Bangkok', productIdPrefix: 'A', claudeModel: 'claude-opus-5', publicBaseUrl: z.url().parse(publicBaseUrl),
    airtableBaseId: s.AIRTABLE_BASE_ID, airtableProductsTableId: s.AIRTABLE_PRODUCTS_TABLE_ID, airtablePublicationRunsTableId: s.AIRTABLE_PUBLICATION_RUNS_TABLE_ID,
    googleDriveFolderId: s.GOOGLE_DRIVE_FOLDER_ID, googleTemplateDocId: s.GOOGLE_TEMPLATE_DOC_ID, lineAllowedGroupIds: s.LINE_ALLOWED_GROUP_IDS,
    soldoutConfirmationEnabled: s.SOLDOUT_CONFIRMATION_ENABLED, firstImportCutoffDate: s.FIRST_IMPORT_CUTOFF_DATE,
    importRetryLimit: s.IMPORT_RETRY_LIMIT, publicationRetryLimit: s.PUBLICATION_RETRY_LIMIT, aiCaptionsEnabled: s.AI_CAPTIONS_ENABLED,
    productIdInitialNumber: s.PRODUCT_ID_INITIAL_NUMBER, claudeRequestInputTokenLimit: s.CLAUDE_REQUEST_INPUT_TOKEN_LIMIT,
    monthlyBudgetThb: s.MONTHLY_BUDGET_THB, usdToThbRate: s.USD_TO_THB_RATE, claudeInputPriceUsdPerMtok: s.CLAUDE_INPUT_PRICE_USD_PER_MTOK,
    claudeOutputPriceUsdPerMtok: s.CLAUDE_OUTPUT_PRICE_USD_PER_MTOK, r2PriceUsdPerGbMonth: s.R2_PRICE_USD_PER_GB_MONTH,
  };
}
export async function loadSettingsSnapshot(env: Env): Promise<SettingsSnapshot> {
  try {
    if (!env.CONFIGURATION_MODE || env.CONFIGURATION_MODE === 'legacy' || env.CONFIGURATION_MODE === 'maintenance') {
      const { lineAllowedGroupId, productIdPrefix, importCron: _importCron, publicationCron: _publicationCron, uploadCutoffMinutes: _uploadCutoffMinutes, ...config } = parseConfig(env.APP_CONFIG_JSON, env.WORKFLOW_RETRY_LIMIT);
      if (productIdPrefix !== 'A') throw new Error('Unsupported product prefix');
      return { schemaVersion: 1, revision: 0, config: { ...config, productIdPrefix: 'A', lineAllowedGroupIds: [lineAllowedGroupId] } };
    }
    if (env.CONFIGURATION_MODE !== 'd1') throw new Error('Unavailable');
    const record = await readSettings(env.DB);
    if (!record) throw new Error('Missing settings');
    return { schemaVersion: 1, revision: record.revision, config: toRuntimeSettings(record.settings, env.PUBLIC_BASE_URL ?? '') };
  } catch { throw new Error('settings_unavailable'); }
}
