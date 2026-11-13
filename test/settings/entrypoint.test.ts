import { describe, expect, it } from 'vitest';
import { testEnv, createTestEnv } from '../helpers/env';
import { getSettingsView, exportSettings } from '../../src/settings/entrypoint';
import { initializeSettings } from '../../src/db/settings-repository';
import type { StoredSettings } from '../../src/settings/schema';
const initial: StoredSettings = { AIRTABLE_BASE_ID: 'app1', AIRTABLE_PRODUCTS_TABLE_ID: 'tbl1', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'tbl2', GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_TEMPLATE_DOC_ID: 'template', LINE_ALLOWED_GROUP_IDS: ['C1'], SOLDOUT_CONFIRMATION_ENABLED: true, FIRST_IMPORT_CUTOFF_DATE: null, IMPORT_RETRY_LIMIT: 0, PUBLICATION_RETRY_LIMIT: 0, AI_CAPTIONS_ENABLED: false, CLAUDE_MODEL: "claude-opus-5", PRODUCT_ID_INITIAL_NUMBER: 1, CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 100, MONTHLY_BUDGET_THB: 1000, USD_TO_THB_RATE: 36, CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25, R2_PRICE_USD_PER_GB_MONTH: 0.015 };
describe('private settings service', () => {
  it('is unavailable outside D1 mode and exports only saved non-secret data', async () => {
    const env = { ...testEnv(), ...createTestEnv(), CONFIGURATION_MODE: 'legacy' as const, PUBLIC_BASE_URL: 'https://example.test', ENVIRONMENT: 'staging' };
    await env.DB.prepare('DELETE FROM app_settings').run();
    await initializeSettings(env.DB, initial, '2026-11-11T00:00:00.000Z');
    expect(await getSettingsView(env)).toEqual({ ok: false, code: 'settings_unavailable' });
    const d1 = { ...env, CONFIGURATION_MODE: 'd1' as const };
    const result = await exportSettings(d1, '2026-11-11T01:00:00.000Z');
    expect(result).toMatchObject({ ok: true, value: { revision: 1, settings: initial, deployment: { schedulingEnabled: false } } });
    expect(JSON.stringify(result)).not.toContain(env.GOOGLE_REFRESH_TOKEN);
  });
});
