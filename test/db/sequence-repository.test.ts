import { describe, expect, it } from "vitest";
import { testEnv } from "../helpers/env";
import { createSequenceRepository } from "../../src/db/sequence-repository";

describe("sequence-repository", () => {
  it("reports not bootstrapped before bootstrap() runs", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    const name = `seq-${crypto.randomUUID()}`;
    expect(await repo.isBootstrapped(name)).toBe(false);
  });

  it("bootstrap sets the starting next_value exactly once", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    const name = `seq-${crypto.randomUUID()}`;
    await repo.bootstrap(name, 500);
    await repo.bootstrap(name, 999); // second call must not move an already-bootstrapped sequence
    expect(await repo.allocateNext(name)).toBe(500);
  });

  it("allocateNext returns strictly increasing, non-repeating numbers under concurrent calls", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    const name = `seq-${crypto.randomUUID()}`;
    await repo.bootstrap(name, 1);
    const allocated = await Promise.all(Array.from({ length: 10 }, () => repo.allocateNext(name)));
    const unique = new Set(allocated);
    expect(unique.size).toBe(10);
    expect(Math.max(...allocated)).toBe(10);
  });

  it("throws when allocating from a sequence that was never bootstrapped", async () => {
    const repo = createSequenceRepository(testEnv().DB);
    await expect(repo.allocateNext(`seq-${crypto.randomUUID()}`)).rejects.toThrow(/not bootstrapped/);
  });
});
