import { expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { runLineCommandRecovery } from "../../src/line/command-workflow";
import { OperationalError } from "../../src/shared/errors";

function setup() {
  const step = {
    do: vi.fn(async (_name, optionsOrCallback, callback) => (callback ?? optionsOrCallback)()),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
  const operations = {
    prepare: vi.fn().mockResolvedValue({ kind: "text", text: "สำเร็จ" }),
    deliver: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
  };
  return { step, operations, run: () => runLineCommandRecovery(step as unknown as WorkflowStep, operations) };
}
const temporary = new OperationalError("provider_failed", "temporarily unavailable", true);

it("retries twice at 30 seconds and 1 minute, then reports failure", async () => {
  const { step, operations, run } = setup();
  operations.prepare.mockRejectedValue(temporary);
  expect(await run()).toEqual({ status: "failed" });
  expect(operations.prepare).toHaveBeenCalledTimes(3);
  expect(step.sleep.mock.calls).toEqual([["retry-wait-0", "30 seconds"], ["retry-wait-1", "1 minute"]]);
  expect(operations.notify.mock.calls.map(call => call[0])).toEqual([
    "⚠️ ระบบขัดข้องชั่วคราว กำลังลองใหม่อัตโนมัติใน 30 วินาที ไม่ต้องส่งคำสั่งซ้ำ",
    "⚠️ ระบบขัดข้องชั่วคราว กำลังลองใหม่อัตโนมัติใน 1 นาที ไม่ต้องส่งคำสั่งซ้ำ",
    "⚠️ ประมวลผลคำสั่งไม่สำเร็จ ระบบหยุดลองใหม่แล้ว กรุณาตรวจสอบข้อมูลก่อนส่งคำสั่งซ้ำ",
  ]);
});

it("sends success after recovery and skips the second retry", async () => {
  const { operations, step, run } = setup();
  operations.prepare.mockRejectedValueOnce(temporary);
  expect(await run()).toEqual({ status: "completed" });
  expect(operations.prepare).toHaveBeenCalledTimes(2);
  expect(operations.deliver).toHaveBeenCalledTimes(1);
  expect(step.sleep).toHaveBeenCalledTimes(1);
});

it("retries only delivery after command success, retaining the same retry key", async () => {
  const { operations, run } = setup();
  operations.deliver.mockRejectedValueOnce(temporary).mockRejectedValueOnce(temporary);
  expect(await run()).toEqual({ status: "completed" });
  expect(operations.prepare).toHaveBeenCalledTimes(1);
  expect(operations.deliver).toHaveBeenCalledTimes(3);
  expect(new Set(operations.deliver.mock.calls.map(call => call[1])).size).toBe(1);
});

it("does not retry permanent errors or validation replies", async () => {
  const failed = setup();
  failed.operations.prepare.mockRejectedValue(new OperationalError("invalid_data", "invalid", false));
  expect(await failed.run()).toEqual({ status: "failed" });
  expect(failed.operations.prepare).toHaveBeenCalledTimes(1);
  expect(failed.step.sleep).not.toHaveBeenCalled();
  const validation = setup();
  validation.operations.prepare.mockResolvedValue({ kind: "text", text: "รหัสสินค้าไม่ถูกต้อง" });
  expect(await validation.run()).toEqual({ status: "completed" });
  expect(validation.operations.notify).not.toHaveBeenCalled();
});

it("continues recovery when LINE cannot deliver a retry notice", async () => {
  const { operations, run } = setup();
  operations.prepare.mockRejectedValueOnce(temporary);
  operations.notify.mockRejectedValueOnce(temporary);
  expect(await run()).toEqual({ status: "completed" });
  expect(operations.prepare).toHaveBeenCalledTimes(2);
});

it("recovers from a Workflow step interruption within the same two-retry budget", async () => {
  const { operations, step, run } = setup();
  let interrupted = false;
  step.do.mockImplementation(async (name, optionsOrCallback, callback) => {
    if (name === "prepare-0" && !interrupted) {
      interrupted = true;
      throw new Error("Workflow step timed out");
    }
    return (callback ?? optionsOrCallback)();
  });
  expect(await run()).toEqual({ status: "completed" });
  expect(operations.prepare).toHaveBeenCalledTimes(1);
  expect(step.sleep).toHaveBeenCalledExactlyOnceWith("retry-wait-0", "30 seconds");
});
