import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { initializeSettings, readSettings, compareAndSetSettings } from '../../src/db/settings-repository';
import type { StoredSettings } from '../../src/settings/schema';

const settings: StoredSettings = {
  AIRTABLE_BASE_ID: 'app1', AIRTABLE_PRODUCTS_TABLE_ID: 'tbl1', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'tbl2', GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_TEMPLATE_DOC_ID: 'template', LINE_ALLOWED_GROUP_IDS: ['C1'], SOLDOUT_CONFIRMATION_ENABLED: true, FIRST_IMPORT_CUTOFF_DATE: null, IMPORT_RETRY_LIMIT: 0, PUBLICATION_RETRY_LIMIT: 0, AI_CAPTIONS_ENABLED: false, CLAUDE_MODEL: "claude-opus-5", PRODUCT_ID_INITIAL_NUMBER: 1, CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 100, MONTHLY_BUDGET_THB: 1000, USD_TO_THB_RATE: 36, CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25, R2_PRICE_USD_PER_GB_MONTH: 0.015,
};

describe('settings repository', () => {
  it('initializes once and conditionally updates a single revision without touching sequences', async () => {
    const db = testEnv().DB;
    await db.prepare('DELETE FROM app_settings').run();
    await db.prepare('INSERT INTO sequences (name, next_value, bootstrapped_at) VALUES (?, ?, ?)').bind('settings-test', 42, 'now').run();
    expect(await readSettings(db)).toBeNull();
    const first = await initializeSettings(db, settings, '2026-11-11T00:00:00.000Z');
    expect(first.revision).toBe(1);
    expect(await initializeSettings(db, { ...settings, AIRTABLE_BASE_ID: 'different' }, '2026-11-12T00:00:00.000Z')).toEqual(first);
    const candidate = { ...settings, MONTHLY_BUDGET_THB: 2000 };
    expect((await compareAndSetSettings(db, 1, candidate, '2026-11-12T00:00:00.000Z'))?.revision).toBe(2);
    expect(await compareAndSetSettings(db, 1, settings, '2026-11-13T00:00:00.000Z')).toBeNull();
    expect((await readSettings(db))?.settings).toEqual(candidate);
    expect(await db.prepare('SELECT next_value FROM sequences WHERE name = ?').bind('settings-test').first()).toEqual({ next_value: 42 });
  });
});
