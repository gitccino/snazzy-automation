import { parseConfig } from "../../src/config";
import { acquireOrResumeJob } from "../../src/db/publication-repository";
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stages = vi.hoisted(() => {
  // Workflow binding registration preloads the Worker modules before this test.
  vi.resetModules();
  return {
    validatePublication: vi.fn(),
    recoverPublicationFinalization: vi.fn(),
    notifyPublicationValidationFailure: vi.fn(),
    preparePublicationOutputs: vi.fn(),
    ensureTemporaryDocument: vi.fn(),
    fillAndVerifyDocument: vi.fn(),
    finalizePublication: vi.fn(),
    notifyPublicationSuccess: vi.fn(),
    failPublicationAfterExhaustion: vi.fn(),
  };
});

vi.mock("../../src/publication/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/publication/service")>()),
  ...stages,
}));

import {
  PublicationWorkflow,
  runPublicationWorkflow,
} from "../../src/publication/workflow";
import type { PublicationServiceDeps } from "../../src/publication/service";
import type { PublicationWorkflowParams } from "../../src/publication/types";
import { OperationalError } from "../../src/shared/errors";
import { createTestEnv, testEnv } from "../helpers/env";

const params = { publicationRunId: "rec-run-1", trigger: "admin" as const };
const deps = { config: { ...parseConfig(JSON.parse(createTestEnv().APP_CONFIG_JSON)), publicationRetryLimit: 5 }, notify:vi.fn().mockResolvedValue(undefined) } as unknown as PublicationServiceDeps;
const validated = {
  run: {
    airtableRunId: "rec-run-1",
    publicationDate: "2026-09-02",
    status: "Ready",
    products: [],
  },
  thaiDate: "2 กันยายน 2569",
};
const prepared = { ...validated, outputs: [] };
const result = {
  publicationRunId: "rec-run-1",
  googleDocId: "temp-doc-1",
  googleDocUrl: "https://docs.google.com/document/d/temp-doc-1/edit",
  productIds: [],
};

function retryingStep(serializeErrors = false) {
  return {
    do: vi.fn(
      async (
        _name: string,
        options: { retries: { limit: number } },
        callback: () => Promise<unknown>,
      ) => {
        for (let call = 0; ; call += 1) {
          try {
            return await callback();
          } catch (error) {
            if (
              call === options.retries.limit ||
              error instanceof NonRetryableError
            ) {
              if (serializeErrors && error instanceof Error) {
                const reconstructed = new Error(error.message);
                reconstructed.name = error.name;
                throw reconstructed;
              }
              throw error;
            }
          }
        }
      },
    ),
  };
}

describe("runPublicationWorkflow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stages.validatePublication.mockResolvedValue({
      kind: "valid",
      value: validated,
    });
    stages.recoverPublicationFinalization.mockResolvedValue(null);
    stages.notifyPublicationValidationFailure.mockImplementation(async d=>d.notify('validation failed',undefined,'validation_failed'));
    stages.preparePublicationOutputs.mockResolvedValue(prepared);
    stages.ensureTemporaryDocument.mockResolvedValue("temp-doc-1");
    stages.fillAndVerifyDocument.mockResolvedValue(undefined);
    stages.finalizePublication.mockResolvedValue(result);
    stages.notifyPublicationSuccess.mockImplementation(async d=>d.notify('success',undefined,'success'));
    stages.failPublicationAfterExhaustion.mockResolvedValue(undefined);
  });

  it("runs seven named durable stages with five exponential retries after the initial call", async () => {
    const step = retryingStep();

    await expect(
      runPublicationWorkflow(params, step as unknown as WorkflowStep, deps),
    ).resolves.toEqual(result);

    expect(step.do.mock.calls.map(([name]) => name)).toEqual([
      "recover finalization",
      "validate publication",
      "prepare outputs",
      "ensure temporary document",
      "fill and verify document",
      "finalize publication",
      "prepare notify publication success",
      "notify publication success",
    ]);
    for (const [name, options] of step.do.mock.calls) {
      expect(options).toEqual(String(name).includes("notify") ? {retries:{limit:2,delay:"1 second"},timeout:"1 minute"} : {
        retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
        timeout: "5 minutes",
      });
    }
    expect(stages.validatePublication).toHaveBeenCalledWith(
      deps,
      "rec-run-1",
      "publication-rec-run-1",
    );
    expect(stages.preparePublicationOutputs).toHaveBeenCalledWith(
      deps,
      validated,
    );
    expect(stages.ensureTemporaryDocument).toHaveBeenCalledWith(deps, prepared);
    expect(stages.fillAndVerifyDocument).toHaveBeenCalledWith(
      deps,
      prepared,
      "temp-doc-1",
    );
    expect(stages.finalizePublication).toHaveBeenCalledWith(
      deps,
      prepared,
      "temp-doc-1",
    );
    expect(stages.notifyPublicationSuccess).toHaveBeenCalledWith(
      expect.objectContaining({config:deps.config,notify:expect.any(Function)}),
      prepared,
      result,
    );
    expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
  });

  it.each([
    [
      "validatePublication",
      "Unable to read or validate publication data.",
      null,
    ],
    [
      "preparePublicationOutputs",
      "Unable to prepare publication images and captions.",
      "2 กันยายน 2569",
    ],
    [
      "ensureTemporaryDocument",
      "Unable to create the temporary Google document.",
      "2 กันยายน 2569",
    ],
    [
      "fillAndVerifyDocument",
      "Unable to fill or verify the Google document.",
      "2 กันยายน 2569",
    ],
    [
      "finalizePublication",
      "Unable to finalize the publication.",
      "2 กันยายน 2569",
    ],
  ] as const)(
    "exhausts six %s attempts before one durable cleanup with a safe reason",
    async (stage, reason, displayDate) => {
      const upstream = new Error(
        "private response Bearer SECRET-AIRTABLE sk-ant-SECRET -----BEGIN PRIVATE KEY-----",
      );
      stages[stage].mockRejectedValue(upstream);
      const step = retryingStep();

      await expect(
        runPublicationWorkflow(params, step as unknown as WorkflowStep, deps),
      ).rejects.toThrow(reason);

      expect(stages[stage]).toHaveBeenCalledTimes(6);
      expect(
        stages.failPublicationAfterExhaustion,
      ).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({config:deps.config,notify:expect.any(Function)}), "rec-run-1", reason, displayDate);
      expect(step.do.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        "record exhausted publication failure",
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "5 minutes",
        },
      ]);
      expect(stages.notifyPublicationSuccess).not.toHaveBeenCalled();
    },
  );

  it("converts a permanent stage error to NonRetryableError at the durable boundary", async () => {
    stages.ensureTemporaryDocument.mockRejectedValue(
      new OperationalError(
        "google_copy_failed",
        "private response SECRET-GOOGLE",
        false,
      ),
    );

    const failure = runPublicationWorkflow(
      params,
      retryingStep() as unknown as WorkflowStep,
      deps,
    );
    await expect(failure).rejects.toBeInstanceOf(NonRetryableError);
    await expect(failure).rejects.toMatchObject({
      name: "google_copy_failed",
      message: "Unable to create the temporary Google document.",
    });
    expect(stages.ensureTemporaryDocument).toHaveBeenCalledTimes(1);
    expect(
      stages.failPublicationAfterExhaustion,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({config:deps.config,notify:expect.any(Function)}),
      "rec-run-1",
      "Unable to create the temporary Google document.",
      "2 กันยายน 2569",
    );
  });

  it.each([
    ["validatePublication", "publication_job_locked", false],
    ["validatePublication", "publication_job_locked", true],
    ["validatePublication", "publication_job_terminal", false],
    ["validatePublication", "publication_job_terminal", true],
    ["preparePublicationOutputs", "publication_job_terminal", true],
  ] as const)(
    "does not clean up a %s contender rejected with %s (serialized: %s)",
    async (stage, code, serializeErrors) => {
      stages[stage].mockRejectedValue(
        new OperationalError(code, "private contender details", false),
      );
      const step = retryingStep(serializeErrors);

      await expect(
        runPublicationWorkflow(params, step as unknown as WorkflowStep, deps),
      ).rejects.toMatchObject({ name: code });

      expect(stages[stage]).toHaveBeenCalledTimes(1);
      expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
      expect(step.do.mock.calls.map(([name]) => name)).not.toContain(
        "record exhausted publication failure",
      );
      expect(stages.notifyPublicationSuccess).not.toHaveBeenCalled();
    },
  );

  it("returns the stored result without regenerating a succeeded publication", async () => {
    stages.validatePublication.mockResolvedValue({
      kind: "already_succeeded",
      result,
    });
    const step = retryingStep();

    await expect(
      runPublicationWorkflow(params, step as unknown as WorkflowStep, deps),
    ).resolves.toEqual(result);

    expect(step.do.mock.calls.map(([name]) => name)).toEqual([
      "recover finalization",
      "validate publication",
    ]);
    expect(stages.preparePublicationOutputs).not.toHaveBeenCalled();
  });

  it.each([null, "transient", "permanent"] as const)(
    "keeps invalid products in Draft when their notification is %s",
    async (failureKind) => {
      const validation = {
        valid: false,
        productsMissingFields: [
          { productId: "A-1001", missingFields: ["Description"] },
        ],
      };
      stages.validatePublication.mockResolvedValue({
        kind: "validation_failed",
        thaiDate: "2 กันยายน 2569",
        validation,
      });
      if (failureKind) {
        stages.notifyPublicationValidationFailure.mockRejectedValue(
          new OperationalError(
            "line_push_failed",
            "LINE unavailable",
            failureKind === "transient",
          ),
        );
      }
      const step = retryingStep();
      const outcome = runPublicationWorkflow(
        params,
        step as unknown as WorkflowStep,
        deps,
      );

      if (failureKind === "permanent")
        await expect(outcome).rejects.toBeInstanceOf(NonRetryableError);
      else if (failureKind)
        await expect(outcome).rejects.toThrow(
          "Unable to prepare publication notification.",
        );
      else await expect(outcome).resolves.toBeNull();

      expect(stages.notifyPublicationValidationFailure).toHaveBeenCalledWith(
        expect.objectContaining({config:deps.config,notify:expect.any(Function)}),
        "rec-run-1",
        "2 กันยายน 2569",
        validation,
      );
      expect(stages.notifyPublicationValidationFailure).toHaveBeenCalledTimes(
        failureKind === "transient" ? 3 : 1,
      );
      expect(stages.preparePublicationOutputs).not.toHaveBeenCalled();
      expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "does not downgrade success when its notification fails (retryable: %s)",
    async (retryable) => {
      stages.notifyPublicationSuccess.mockRejectedValue(
        new OperationalError("line_push_failed", "LINE unavailable", retryable),
      );

      await expect(
        runPublicationWorkflow(
          params,
          retryingStep() as unknown as WorkflowStep,
          deps,
        ),
      ).rejects.toMatchObject({
        message: "Unable to prepare publication notification.",
      });

      expect(stages.finalizePublication).toHaveBeenCalledTimes(1);
      expect(stages.notifyPublicationSuccess).toHaveBeenCalledTimes(
        retryable ? 3 : 1,
      );
      expect(stages.failPublicationAfterExhaustion).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "applies the retry policy to exhausted-failure cleanup (retryable: %s)",
    async (retryable) => {
      stages.fillAndVerifyDocument.mockRejectedValue(
        new Error("Google unavailable"),
      );
      stages.failPublicationAfterExhaustion.mockRejectedValue(
        new OperationalError("line_push_failed", "LINE unavailable", retryable),
      );

      await expect(
        runPublicationWorkflow(
          params,
          retryingStep() as unknown as WorkflowStep,
          deps,
        ),
      ).rejects.toMatchObject({
        message: "Unable to fill or verify the Google document.",
      });

      expect(stages.fillAndVerifyDocument).toHaveBeenCalledTimes(6);
      expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('ยังยืนยันสถานะ'),expect.objectContaining({type:'bubble'}),'unconfirmed');
      expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledTimes(
        retryable ? 6 : 1,
      );
    },
  );

  it("attempts publication and failure cleanup once when retries are disabled", async () => {
    stages.preparePublicationOutputs.mockRejectedValue(
      new OperationalError("provider_failed", "Unavailable", true),
    );
    stages.failPublicationAfterExhaustion.mockRejectedValue(
      new OperationalError("cleanup_failed", "Unavailable", true),
    );
    await expect(
      runPublicationWorkflow(
        params,
        retryingStep() as unknown as WorkflowStep,
        {
          ...deps,
          config: { ...deps.config, publicationRetryLimit: 0 },
        },
      ),
    ).rejects.toThrow();
    expect(stages.preparePublicationOutputs).toHaveBeenCalledTimes(1);
    expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledTimes(1);
  });

  it("runs with captioning disabled and no Anthropic key", async () => {
    await acquireOrResumeJob(
      testEnv().DB,
      { now: () => new Date() },
      params.publicationRunId,
      "publication-rec-run-1",
    );
    const env = {
      ...testEnv(),
      ...createTestEnv(),
      ANTHROPIC_API_KEY: undefined,
      WORKFLOW_RETRY_LIMIT: "0",
    };
    const config = JSON.parse(env.APP_CONFIG_JSON);
    delete config.AI_CAPTIONS_ENABLED;
    env.APP_CONFIG_JSON = JSON.stringify(config);
    await expect(
      PublicationWorkflow.prototype.run.call(
        { env } as unknown as PublicationWorkflow,
        { payload: params } as WorkflowEvent<PublicationWorkflowParams>,
        retryingStep() as unknown as WorkflowStep,
      ),
    ).resolves.toEqual(result);
    const actualDeps = stages.validatePublication.mock
      .calls[0]?.[0] as PublicationServiceDeps;
    expect(actualDeps.config.aiCaptionsEnabled).toBe(false);
    expect(actualDeps.config.publicationRetryLimit).toBe(0);
  });

  it("constructs the official Anthropic client with SDK retries disabled in the bound Workflow", async () => {
    await acquireOrResumeJob(
      testEnv().DB,
      { now: () => new Date() },
      params.publicationRunId,
      "publication-rec-run-1",
    );
    const env = { ...testEnv(), ...createTestEnv() };

    // The platform owns WorkflowEntrypoint construction; exercise its run boundary with test bindings.
    await expect(
      PublicationWorkflow.prototype.run.call(
        { env } as unknown as PublicationWorkflow,
        { payload: params } as WorkflowEvent<PublicationWorkflowParams>,
        retryingStep() as unknown as WorkflowStep,
      ),
    ).resolves.toEqual(result);

    const actualDeps = stages.validatePublication.mock
      .calls[0]?.[0] as PublicationServiceDeps;
    expect(actualDeps.anthropic).toBeInstanceOf(Anthropic);
    expect((actualDeps.anthropic as Anthropic).maxRetries).toBe(0);
    expect(actualDeps.db).toBe(env.DB);
    expect(actualDeps.clock.now()).toBeInstanceOf(Date);
  });

  it("resumes saved finalization without rereading changed products or refilling", async () => {
    const recovered = { result, thaiDate: "2 กันยายน 2569", generation: 2 };
    stages.recoverPublicationFinalization.mockResolvedValue(recovered);
    await expect(
      runPublicationWorkflow(
        { ...params, trigger: "line", generation: 2 },
        retryingStep() as unknown as WorkflowStep,
        deps,
      ),
    ).resolves.toEqual(result);
    expect(stages.validatePublication).not.toHaveBeenCalled();
    expect(stages.fillAndVerifyDocument).not.toHaveBeenCalled();
    expect(stages.notifyPublicationSuccess).toHaveBeenCalledWith(
      expect.objectContaining({config:deps.config,notify:expect.any(Function)}),
      recovered,
      result,
    );
  });
});

it('retries only enqueue after a lost D1 response using the frozen terminal snapshot',async()=>{
 vi.clearAllMocks();
 const {createLineReplyRepository}=await import('../../src/db/line-reply-repository');
 const id=crypto.randomUUID(); const repo=createLineReplyRepository(testEnv().DB,{now:()=>new Date()});
 let attempts=0;
 const notify=async(text:string)=>{
   attempts++;
   await repo.enqueueResult({resultKey:id,groupId:id,result:{schemaVersion:1,kind:'publication',runId:id,generation:1,notificationCycle:1,outcome:'success',messages:[{type:'text',text}]}});
   if(attempts===1)throw new Error('response lost after commit');
 };
 stages.recoverPublicationFinalization.mockResolvedValue({result,thaiDate:'original date'});
 stages.notifyPublicationSuccess.mockImplementation(async d=>d.notify('original result'));
 await expect(runPublicationWorkflow(params,retryingStep() as unknown as WorkflowStep,{...deps,notify})).resolves.toEqual(result);
 expect(attempts).toBe(2);expect((await repo.head(id))?.result.messages).toEqual([{type:'text',text:'original result'}]);
 expect(stages.notifyPublicationSuccess).toHaveBeenCalledTimes(1);
 expect(stages.finalizePublication).not.toHaveBeenCalled();
});
it('renders verify-first uncertainty and preserves both safe failure codes without secrets',async()=>{
 vi.clearAllMocks();const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 stages.recoverPublicationFinalization.mockResolvedValue(null);
 stages.validatePublication.mockRejectedValue(new OperationalError('anthropic_create_message_failed','SECRET original response',true));
 stages.failPublicationAfterExhaustion.mockRejectedValue(new OperationalError('google_token_exchange_failed','SECRET refresh token',true));
 const notify=vi.fn().mockResolvedValue(undefined);
 try {
  await expect(runPublicationWorkflow(params,retryingStep() as unknown as WorkflowStep,{...deps,notify,config:{...deps.config,publicationRetryLimit:0}})).rejects.toThrow();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('ยังยืนยันสถานะ'),expect.objectContaining({type:'bubble'}),'unconfirmed');
  const [alt,contents]=notify.mock.calls[0]!;
  expect.soft(alt).not.toContain('สร้างเอกสารไม่สำเร็จ');expect.soft(alt).not.toContain('เพื่อลองใหม่');
  expect.soft(JSON.stringify(contents)).not.toContain('สร้างเอกสารไม่สำเร็จ');expect.soft(JSON.stringify(contents)).not.toContain('เพื่อลองใหม่');
  expect(JSON.stringify(contents)).toContain('ตรวจสอบ');
  expect(log).toHaveBeenCalledWith('publication_failure_recording_unconfirmed',expect.objectContaining({originalCode:'anthropic_create_message_failed',recordingCode:'google_token_exchange_failed'}));
  expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
 } finally {log.mockRestore();}
});

it('persists the primary failure and notice intent before cleanup fails', async () => {
  vi.clearAllMocks();
  const db = testEnv().DB, runId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const workflowId = `publication-${runId}`;
  await db.prepare(`INSERT INTO publication_jobs (publication_run_id, publication_date, state, correlation_id, created_at, updated_at, generation, notification_cycle, settings_context_json) VALUES (?, ?, 'generating', ?, 'x', 'x', 1, 1, ?)`)
    .bind(runId, '2026-11-20', workflowId, JSON.stringify({replyGroupId:groupId})).run();
  stages.recoverPublicationFinalization.mockResolvedValue(null);
  stages.validatePublication.mockRejectedValue(new OperationalError('primary_failed','SECRET original',true));
  const facts = () => db.prepare('SELECT stage, failure_code FROM workflow_feedback WHERE run_id=?').bind(runId).first();
  const notices = () => db.prepare('SELECT result_key, outcome_json FROM workflow_feedback_results WHERE run_id=?').bind(runId).all();
  stages.failPublicationAfterExhaustion.mockImplementation(async () => {
    expect(await facts()).toEqual({stage:'validate publication',failure_code:'primary_failed'});
    expect((await notices()).results).toHaveLength(1);
    throw new OperationalError('cleanup_failed','SECRET cleanup',true);
  });
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    await expect(runPublicationWorkflow({publicationRunId:runId,trigger:'line'},retryingStep() as unknown as WorkflowStep,{...deps,db,config:{...deps.config,publicationRetryLimit:0}},workflowId,{groupId,notificationCycle:1})).rejects.toThrow();
    expect(stages.failPublicationAfterExhaustion).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('publication_failure_recording_unconfirmed',expect.objectContaining({recordingCode:'cleanup_failed'}));
    expect(await facts()).toEqual({stage:'validate publication',failure_code:'primary_failed'});
    const rows=(await notices()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({result_key:JSON.stringify(['publication',runId,1,1,'terminal'])});
    expect(JSON.parse(String(rows[0]?.outcome_json))).toMatchObject({stage:'validate publication',failureCode:'primary_failed',action:'verify',outcome:'unconfirmed'});
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  } finally { log.mockRestore(); }
});

it.each(['cleanup_failed', 'airtable_update_failed'])('queues the saved primary failure once when %s occurs', async code => {
  vi.clearAllMocks();
  const db=testEnv().DB, runId=crypto.randomUUID(), groupId=crypto.randomUUID(), workflowId=`publication-${runId}`;
  await db.prepare(`INSERT INTO publication_jobs (publication_run_id, publication_date, state, correlation_id, created_at, updated_at, generation, notification_cycle, settings_context_json) VALUES (?, ?, 'generating', ?, 'x', 'x', 1, 1, ?)`)
    .bind(runId,runId,workflowId,JSON.stringify({replyGroupId:groupId})).run();
  stages.recoverPublicationFinalization.mockResolvedValue(null);
  stages.validatePublication.mockResolvedValue({kind:'ready',value:validated});
  stages.preparePublicationOutputs.mockRejectedValue(new OperationalError('anthropic_create_message_failed','SECRET primary',true));
  stages.failPublicationAfterExhaustion.mockRejectedValue(new OperationalError(code,'SECRET secondary',true));
  const {createLineReplyRepository}=await import('../../src/db/line-reply-repository');
  const repo=createLineReplyRepository(db,{now:()=>new Date()});
  const key=JSON.stringify(['publication',runId,1,1,'terminal']);
  const notify=async(text:string,contents?:Record<string,unknown>,outcome:'success'|'failed'|'unconfirmed'='success')=>repo.enqueueResult({groupId,resultKey:key,result:{schemaVersion:1,kind:'publication',runId,generation:1,notificationCycle:1,outcome,messages:[contents?{type:'flex',altText:text,contents}:{type:'text',text}]}});
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try {
    for(let i=0;i<2;i++) await expect(runPublicationWorkflow({publicationRunId:runId,trigger:'line'},retryingStep() as unknown as WorkflowStep,{...deps,db,notify,config:{...deps.config,publicationRetryLimit:0}},workflowId,{groupId,notificationCycle:1})).rejects.toMatchObject({name:'anthropic_create_message_failed'});
    const rows=(await db.prepare('SELECT result_key,result_json FROM line_result_outbox WHERE group_id=?').bind(groupId).all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result_key).toBe(key);
    const message=String(rows[0]?.result_json);
    expect(message).toContain('คำบรรยาย');
    expect(message).toContain('ตรวจสอบ');
    expect(message).toContain('สถานะการล้างข้อมูลหรือบันทึก Airtable');
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('ยังยืนยันสถานะ');
    expect(message).not.toContain('ลองใหม่');
  } finally {
    log.mockRestore();
    await db.prepare('DELETE FROM line_result_outbox WHERE group_id=?').bind(groupId).run();
    await db.prepare('DELETE FROM workflow_feedback_results WHERE run_id=?').bind(runId).run();
    await db.prepare('DELETE FROM workflow_feedback WHERE run_id=?').bind(runId).run();
    await db.prepare('DELETE FROM publication_jobs WHERE publication_run_id=?').bind(runId).run();
  }
});
