import { describe, expect, it } from "vitest";
import { verifyAdminBearer } from "../../src/shared/admin-auth";

describe("verifyAdminBearer", () => {
  // Mutation: accepting any bearer value, normalizing its case/spacing, or accepting an empty secret.
  it("accepts only an exact nonempty bearer value", async () => {
    for (const authorization of [undefined, "Basic admin-secret", "Bearer", "Bearer ", "bearer admin-secret", "Bearer  admin-secret", "Bearer\tadmin-secret", "Bearer admin- secret", "Bearer wrong", "Bearer admin-secret extra"]) {
      const request = new Request("https://worker.example/upload", {
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(await verifyAdminBearer(request, "admin-secret"), authorization).toBe(false);
    }
    const request = new Request("https://worker.example/upload", {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(await verifyAdminBearer(request, "admin-secret")).toBe(true);
    expect(await verifyAdminBearer(request, "")).toBe(false);
  });
});
