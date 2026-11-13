import { loadConfig, readConfigDiagnostics } from "../src/config";

const config = loadConfig();
const diagnostics = readConfigDiagnostics() as unknown as Record<string, unknown>;
const errors = (diagnostics.errors ?? []) as unknown[];
const warnings = (diagnostics.warnings ?? []) as unknown[];
console.log(JSON.stringify({
  providers: Object.keys(config.providers ?? {}).length,
  combos: Object.keys(config.combos ?? {}).length,
  defaultProvider: config.defaultProvider,
  warnings: warnings.length,
  errors: errors.length,
  firstWarnings: warnings.slice(0, 5),
  firstErrors: errors.slice(0, 3),
}, null, 1));
