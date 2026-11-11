import { describe, expect, it } from 'vitest';
import { normalizeGroupIds, parseStoredSettings, parseSaveSectionRequest } from '../../src/settings/schema';

const settings = {
  AIRTABLE_BASE_ID: 'app1', AIRTABLE_PRODUCTS_TABLE_ID: 'tbl1', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'tbl2',
  GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_TEMPLATE_DOC_ID: 'template', LINE_ALLOWED_GROUP_IDS: ['C1'],
  SOLDOUT_CONFIRMATION_ENABLED: true, FIRST_IMPORT_CUTOFF_DATE: null, IMPORT_RETRY_LIMIT: 0,
  PUBLICATION_RETRY_LIMIT: 5, AI_CAPTIONS_ENABLED: false, PRODUCT_ID_INITIAL_NUMBER: 1,
  CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150000, MONTHLY_BUDGET_THB: 1000, USD_TO_THB_RATE: 36,
  CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25, R2_PRICE_USD_PER_GB_MONTH: 0.015,
};

describe('settings contract', () => {
  it('normalizes multiple groups and removes duplicates', () => {
    expect(normalizeGroupIds(' C1, C2\nC1 ')).toEqual(['C1', 'C2']);
    expect(() => normalizeGroupIds(' , ')).toThrow();
    expect(() => normalizeGroupIds('C1,,C2')).toThrow();
  });
  it('accepts allowed limits and rejects invalid or secret data', () => {
    expect(parseStoredSettings(settings)).toEqual(settings);
    for (const changes of [{ IMPORT_RETRY_LIMIT: 1 }, { IMPORT_RETRY_LIMIT: 0.5 }, { CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 150001 }, { FIRST_IMPORT_CUTOFF_DATE: 'invalid' }, { GOOGLE_REFRESH_TOKEN: 'secret' }]) {
      expect(() => parseStoredSettings({ ...settings, ...changes })).toThrow();
    }
  });
  it('enforces section ownership and rejects unknown fields', () => {
    expect(parseSaveSectionRequest({ expectedRevision: 1, section: 'import', changes: { IMPORT_RETRY_LIMIT: 5 } }).changes).toEqual({ IMPORT_RETRY_LIMIT: 5 });
    expect(() => parseSaveSectionRequest({ expectedRevision: 1, section: 'import', changes: { AI_CAPTIONS_ENABLED: true } })).toThrow();
    expect(() => parseSaveSectionRequest({ expectedRevision: 1, section: 'advanced', changes: { GOOGLE_REFRESH_TOKEN: 'secret' } })).toThrow();
  });
});
