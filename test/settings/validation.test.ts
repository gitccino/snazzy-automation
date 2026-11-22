import { describe, expect, it, vi } from 'vitest';
import { createTestEnv, testEnv } from '../helpers/env';
import { validateSettingsConnections } from '../../src/settings/validation';
import type { StoredSettings } from '../../src/settings/schema';
import { requiredFields } from '../../src/routes/setup';

const settings: StoredSettings = { ICLOUD_ALBUMS: [], AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID:null, MESSENGER_COMPLETION_USER_IDS:[], AIRTABLE_BASE_ID: 'app1', AIRTABLE_PRODUCTS_TABLE_ID: 'tbl1', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'tbl2', GOOGLE_DRIVE_FOLDER_ID: 'folder', GOOGLE_TEMPLATE_DOC_ID: 'template', LINE_ALLOWED_GROUP_IDS: ['C1'], SOLDOUT_CONFIRMATION_ENABLED: true, FIRST_IMPORT_CUTOFF_DATE: null, IMPORT_RETRY_LIMIT: 0, PUBLICATION_RETRY_LIMIT: 0, AI_CAPTIONS_ENABLED: false, CLAUDE_MODEL: "claude-opus-5", PRODUCT_ID_INITIAL_NUMBER: 1, CLAUDE_REQUEST_INPUT_TOKEN_LIMIT: 100, MONTHLY_BUDGET_THB: 1000, USD_TO_THB_RATE: 36, CLAUDE_INPUT_PRICE_USD_PER_MTOK: 5, CLAUDE_OUTPUT_PRICE_USD_PER_MTOK: 25, R2_PRICE_USD_PER_GB_MONTH: 0.015 };
const env = { ...testEnv(), ...createTestEnv() };

describe('settings provider validation', () => {
  it('does not contact unrelated providers for a cost change', async () => {
    const fetcher = vi.fn();
    expect(await validateSettingsConnections(env, settings, { ...settings, MONTHLY_BUDGET_THB: 2000 }, ['MONTHLY_BUDGET_THB'], fetcher)).toEqual({ ok: true, value: undefined });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks candidate LINE groups read-only and never leaks provider errors', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('sentinel-secret', { status: 403 }));
    const candidate = { ...settings, LINE_ALLOWED_GROUP_IDS: ['Cnew'] };
    const result = await validateSettingsConnections(env, settings, candidate, ['LINE_ALLOWED_GROUP_IDS'], fetcher);
    expect(result).toEqual({ ok: false, code: 'connection_validation_failed' });
    expect(JSON.stringify(result)).not.toContain('sentinel-secret');
    expect(fetcher.mock.calls[0]?.[0]).toContain('/group/Cnew/summary');
    expect(fetcher.mock.calls[0]?.[1]?.method ?? 'GET').toBe('GET');
  });
  it('checks the candidate Airtable base and both candidate schemas', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ tables: [
      { id: 'newProducts', fields: requiredFields.Products.map(name => ({ name })) },
      { id: 'newRuns', fields: requiredFields['Publication Runs'].map(name => ({ name })) },
    ] }));
    const candidate = { ...settings, AIRTABLE_BASE_ID: 'newBase', AIRTABLE_PRODUCTS_TABLE_ID: 'newProducts', AIRTABLE_PUBLICATION_RUNS_TABLE_ID: 'newRuns' };
    expect(await validateSettingsConnections(env, settings, candidate, ['AIRTABLE_BASE_ID'], fetcher)).toEqual({ ok: true, value: undefined });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.airtable.com/v0/meta/bases/newBase/tables');
    expect(fetcher.mock.calls[0]?.[1]?.method ?? 'GET').toBe('GET');
  });
  it('checks Google candidate folder and template without creating a document', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'token', expires_in: 3600 });
      if (url.includes('/drive/v3/files/newFolder')) return Response.json({ id: 'newFolder', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
      if (url.includes('/drive/v3/files/newTemplate')) return Response.json({ id: 'newTemplate', mimeType: 'application/vnd.google-apps.document', parents: ['newFolder'] });
      if (url.includes('/documents/newTemplate')) return Response.json({ body: { content: [{ paragraph: { elements: [{ startIndex: 1, textRun: { content: '{{PUBLICATION_DATE}} {{PRODUCTS}}x{{END_PRODUCTS}}' } }] } }] } });
      throw new Error(`Unexpected ${init?.method ?? 'GET'} request`);
    });
    const candidate = { ...settings, GOOGLE_DRIVE_FOLDER_ID: 'newFolder', GOOGLE_TEMPLATE_DOC_ID: 'newTemplate' };
    expect(await validateSettingsConnections(env, settings, candidate, ['GOOGLE_DRIVE_FOLDER_ID'], fetcher)).toEqual({ ok: true, value: undefined });
    expect(fetcher.mock.calls.slice(1).every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
});

it('verifies the selected model and accepts a resolved alias', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: 'claude-sonnet-4-5-20250929', type: 'model', display_name: 'Sonnet', created_at: '2025-09-29T00:00:00Z' }));
  const current = { ...settings, AI_CAPTIONS_ENABLED: true };
  const candidate = { ...current, CLAUDE_MODEL: 'claude-sonnet-4-5' };
  expect(await validateSettingsConnections(env, current, candidate, ['CLAUDE_MODEL'], fetcher)).toEqual({ ok: true, value: undefined });
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/models/claude-sonnet-4-5');
});

it('rejects unavailable models when captions are enabled and skips the probe when disabled', async () => {
  const fetcher = vi.fn(async () => new Response('private provider error', { status: 404 }));
  const candidate = { ...settings, AI_CAPTIONS_ENABLED: true, CLAUDE_MODEL: 'claude-unavailable' };
  expect(await validateSettingsConnections(env, { ...settings, AI_CAPTIONS_ENABLED: true }, candidate, ['CLAUDE_MODEL'], fetcher)).toEqual({ ok: false, code: 'connection_validation_failed' });
  fetcher.mockClear();
  expect(await validateSettingsConnections(env, settings, { ...candidate, AI_CAPTIONS_ENABLED: false }, ['CLAUDE_MODEL'], fetcher)).toEqual({ ok: true, value: undefined });
  expect(fetcher).not.toHaveBeenCalled();
});

it('requires messenger table field types, choices and correct product link', async () => {
 const candidate={...settings,AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID:'tblMess',MESSENGER_COMPLETION_USER_IDS:[]};
 const fields: {name:string;type:string;options?:{linkedTableId?:string;choices?:{name:string}[]}}[]=[...['Delivery ID','Product ID','Responsible User ID','Responsible Name','Source Group ID','Source Message ID','Source Event ID','Source Quote Token','Completed By User ID','Completed By Name'].map(name=>({name,type:'singleLineText'})),...['Scheduled At','Registered At','Completed At'].map(name=>({name,type:'dateTime'})),{name:'Product',type:'multipleRecordLinks',options:{linkedTableId:'tbl1'}},{name:'Schedule Type',type:'singleSelect',options:{choices:[{name:'Immediate'},{name:'Scheduled'}]}},{name:'Status',type:'singleSelect',options:{choices:[{name:'Pending'},{name:'Done'}]}}];
 const fetcher=async()=>Response.json({tables:[{id:'tbl1',fields:requiredFields.Products.map(name=>({name}))},{id:'tbl2',fields:requiredFields['Publication Runs'].map(name=>({name}))},{id:'tblMess',fields}]});
 expect(await validateSettingsConnections(testEnv(),settings,candidate,['AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID'],fetcher)).toMatchObject({ok:true});
 fields.find(f=>f.name==='Product')!.options={linkedTableId:'wrong'};
 expect(await validateSettingsConnections(testEnv(),settings,candidate,['AIRTABLE_MESSENGER_DELIVERIES_TABLE_ID'],fetcher)).toMatchObject({ok:false});
});

it('validates mapped single-select brand/model and preserves extra status choices', async()=> {
  const map={'Product ID':'รหัสสินค้าstock','Brand Name':'ชื่อแบรนด์','Model Name':'ชื่อรุ่น','Inventory Status':'สถานะ'};
  const candidate={...settings,AIRTABLE_PRODUCT_FIELD_MAP:map};
  const productFields=requiredFields.Products.map(name=>({name:map[name as keyof typeof map] ?? name,type:['Brand Name','Model Name','Inventory Status'].includes(name)?'singleSelect':'singleLineText',...(name==='Inventory Status'?{options:{choices:['In','Out','Reserve','Rent','Trade','Pledge','Future'].map(name=>({name}))}}:{})}));
  const fetcher=async()=>Response.json({tables:[{id:'tbl1',fields:productFields},{id:'tbl2',fields:requiredFields['Publication Runs'].map(name=>({name}))}]});
  expect(await validateSettingsConnections(env,settings,candidate,['AIRTABLE_PRODUCT_FIELD_MAP'],fetcher)).toMatchObject({ok:true});
  productFields.find(field=>field.name==='ชื่อแบรนด์')!.type='multipleSelects';
  expect(await validateSettingsConnections(env,settings,candidate,['AIRTABLE_PRODUCT_FIELD_MAP'],fetcher)).toMatchObject({ok:false});
});
