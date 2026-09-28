import { execFileSync } from "node:child_process";
import { buildWorkerAppConfig } from "./worker-app-config";

const environment = process.argv[2];
if (environment !== "staging" && environment !== "production") {
  throw new Error("Environment must be staging or production.");
}

const appConfigJson = JSON.stringify(buildWorkerAppConfig(process.env));

execFileSync("npx", ["wrangler", "secret", "put", "APP_CONFIG_JSON", "--env", environment], {
  input: appConfigJson,
  stdio: ["pipe", "inherit", "inherit"],
});

execFileSync("npm", ["run", `deploy:${environment}`], { stdio: "inherit" });
