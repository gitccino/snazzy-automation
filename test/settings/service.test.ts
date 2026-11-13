import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env';
import { initializeSettings, readSettings } from '../../src/db/settings-repository';
import { saveSettingsSection } from '../../src/settings/service';
import type { StoredSettings } from '../../src/settings/schema';

const initial: StoredSettings = { AIRTABLE_BASE_ID: 'app1', AIRTABLE_PRODUCTS_TABLE_ID: 'tbl1', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'tbl2', GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_TEMPLATE_DOC_ID: 'template', LINE_ALLOWED_GROUP_IDS: ['C1'], SOLDOUT_CONFIRMATION_ENABLED: true, FIRST_IMPORT_CUTOFF_DATE: null, IMPORT_RETRY_LIMIT: 0, PUBLICATION_RETRY_LIMIT: 0, AI_CAPTIONS_ENABLED: false, CLAUDE_MODEL: "claude-opus-5", PRODUCT_ID_INITIAL_NUMBER: 1, CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 100, MONTHLY_BUDGET_THB: 1000, USD_TO_THB_RATE: 36, CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25, R2_PRICE_USD_PER_GB_MONTH: 0.015 };
const pass = async () => ({ ok: true as const, value: undefined });

describe('section saves', () => {
  it('requires acknowledgement only for a changed Airtable target, validates, and protects revisions', async () => {
    const db = testEnv().DB;
    await db.prepare('DELETE FROM app_settings').run();
    await initializeSettings(db, initial, '2026-11-11T00:00:00.000Z');
    const change = { expectedRevision: 1, section: 'connections', changes: { AIRTABLE_BASE_ID: 'app2' } };
    expect(await saveSettingsSection(db, change, '2026-11-11T00:00:01.000Z', pass)).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(await saveSettingsSection(db, { ...change, acknowledgeAirtableChange: true }, '2026-11-11T00:00:01.000Z', async () => ({ ok: false, code: 'connection_validation_failed' }))).toMatchObject({ ok: false });
    expect((await readSettings(db))?.settings.AIRTABLE_BASE_ID).toBe('app1');
    expect(await saveSettingsSection(db, { ...change, acknowledgeAirtableChange: true }, '2026-11-11T00:00:01.000Z', pass)).toMatchObject({ ok: true, value: { revision: 2, settings: { AIRTABLE_BASE_ID: 'app2', LINE_ALLOWED_GROUP_IDS: ['C1'] } } });
    expect(await saveSettingsSection(db, change, '2026-11-11T00:00:01.000Z', pass)).toMatchObject({ ok: false, code: 'revision_conflict' });
    expect(await saveSettingsSection(db, { expectedRevision: 2, section: 'connections', changes: { AIRTABLE_BASE_ID: 'app2' } }, '2026-11-11T00:00:02.000Z', pass)).toMatchObject({ ok: true });
    expect(await saveSettingsSection(db, { expectedRevision: 3, section: 'advanced', changes: { PRODUCT_ID_INITIAL_NUMBER: 500 } }, '2026-11-11T00:00:03.000Z', pass)).toMatchObject({ ok: false, code: 'invalid_settings' });
  });
});

it('persists the model in D1 without resetting it on other document changes', async () => {
  const db = testEnv().DB;
  await db.prepare('DELETE FROM app_settings').run();
  await initializeSettings(db, initial, '2026-11-12T00:00:00Z');
  expect(await saveSettingsSection(db, { expectedRevision: 1, section: 'documents', changes: { CLAUDE_MODEL: 'claude-sonnet-4-5' } }, '2026-11-12T00:00:01Z', pass)).toMatchObject({ ok: true });
  expect(await saveSettingsSection(db, { expectedRevision: 2, section: 'documents', changes: { PUBLICATION_RETRY_LIMIT: 5 } }, '2026-11-12T00:00:02Z', pass)).toMatchObject({ ok: true });
  expect((await readSettings(db))?.settings.CLAUDE_MODEL).toBe('claude-sonnet-4-5');
});
