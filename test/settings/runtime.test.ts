import { describe, expect, it } from 'vitest';
import { createTestEnv, testEnv } from '../helpers/env';
import { toRuntimeSettings, loadSettingsSnapshot } from '../../src/settings/runtime';
import { initializeSettings } from '../../src/db/settings-repository';
import type { StoredSettings } from '../../src/settings/schema';
const initial: StoredSettings = { AIRTABLE_BASE_ID: 'appNew', AIRTABLE_PRODUCTS_TABLE_ID: 'tbl1', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'tbl2', GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_TEMPLATE_DOC_ID: 'template', LINE_ALLOWED_GROUP_IDS: ['C1', 'C2'], SOLDOUT_CONFIRMATION_ENABLED: true, FIRST_IMPORT_CUTOFF_DATE: null, IMPORT_RETRY_LIMIT: 0, PUBLICATION_RETRY_LIMIT: 0, AI_CAPTIONS_ENABLED: false, CLAUDE_MODEL: "claude-opus-5", PRODUCT_ID_INITIAL_NUMBER: 1, CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 100, MONTHLY_BUDGET_THB: 1000, USD_TO_THB_RATE: 36, CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25, R2_PRICE_USD_PER_GB_MONTH: 0.015 };
describe('runtime settings', () => {
  it('loads legacy only in bridge mode and fails closed on missing D1', async () => {
    const env = { ...testEnv(), ...createTestEnv(), CONFIGURATION_MODE: 'legacy' as const, WORKFLOW_RETRY_LIMIT: '0' };
    await env.DB.prepare('DELETE FROM app_settings').run();
    expect((await loadSettingsSnapshot(env)).config).toMatchObject({ airtableBaseId: 'appTest', importRetryLimit: 0, lineAllowedGroupIds: ['CtestGroup'] });
    const d1 = { ...env, CONFIGURATION_MODE: 'd1' as const, PUBLIC_BASE_URL: 'https://new.example' };
    await expect(loadSettingsSnapshot(d1)).rejects.toThrow('settings_unavailable');
    await initializeSettings(env.DB, initial, '2026-11-11T00:00:00.000Z');
    expect(await loadSettingsSnapshot(d1)).toMatchObject({ revision: 1, config: { airtableBaseId: 'appNew', importRetryLimit: 0, publicBaseUrl: 'https://new.example', lineAllowedGroupIds: ['C1', 'C2'] } });
    await env.DB.prepare("UPDATE app_settings SET settings_json = '{}' WHERE id = 1").run();
    await expect(loadSettingsSnapshot(d1)).rejects.toThrow('settings_unavailable');
  });
});

it('uses the saved model in new runtime snapshots', () => {
  expect(toRuntimeSettings({ ...initial, CLAUDE_MODEL: 'claude-sonnet-4-5' }, 'https://example.com').claudeModel).toBe('claude-sonnet-4-5');
});
