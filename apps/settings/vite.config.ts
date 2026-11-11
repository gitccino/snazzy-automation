import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { sampleView } from "./test/sample.ts";
import {
  parseSaveSectionRequest,
  parseStoredSettings,
} from "../../src/settings/schema.ts";

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    {
      name: "disposable-local-settings",
      apply: "serve",
      configureServer(server) {
        let view = sampleView();
        server.middlewares.use("/api", async (req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          const send = (value: unknown, status = 200) => {
            res.statusCode = status;
            res.end(JSON.stringify(value));
          };
          if (req.method === "GET" && req.url === "/settings")
            return send({ ok: true, value: view });
          if (req.method === "GET" && req.url === "/settings/export")
            return send({
              schemaVersion: 1,
              environment: "local sample",
              revision: view.record.revision,
              exportedAt: new Date().toISOString(),
              settings: view.record.settings,
              deployment: view.deployment,
            });
          if (req.method === "POST" && req.url === "/settings/test-connection")
            return send({ ok: false, code: "provider_unavailable" }, 503);
          if (
            req.method === "PATCH" &&
            req.url?.startsWith("/settings/sections/")
          ) {
            try {
              let body = "";
              for await (const chunk of req) {
                body += chunk;
                if (Buffer.byteLength(body) > 32768)
                  return send({ ok: false, code: "invalid_settings" }, 400);
              }
              const input = parseSaveSectionRequest(JSON.parse(body));
              if (req.url !== `/settings/sections/${input.section}`)
                return send({ ok: false, code: "invalid_settings" }, 400);
              if (input.expectedRevision !== view.record.revision)
                return send({ ok: false, code: "revision_conflict" }, 409);
              const candidate = parseStoredSettings({
                ...view.record.settings,
                ...input.changes,
              });
              const airtableChanged = Object.keys(input.changes).some(
                (key) =>
                  key.startsWith("AIRTABLE_") &&
                  candidate[key as keyof typeof candidate] !==
                    view.record.settings[key as keyof typeof candidate],
              );
              if (airtableChanged && !input.acknowledgeAirtableChange)
                return send({ ok: false, code: "confirmation_required" }, 409);
              view = {
                ...view,
                record: {
                  ...view.record,
                  settings: candidate,
                  revision: view.record.revision + 1,
                  updatedAt: new Date().toISOString(),
                },
              };
              return send({ ok: true, value: view });
            } catch {
              return send({ ok: false, code: "invalid_settings" }, 400);
            }
          }
          send({ ok: false, code: "not_found" }, 404);
        });
      },
    },
  ],
});
