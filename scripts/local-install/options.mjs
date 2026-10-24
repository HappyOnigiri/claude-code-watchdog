/// <reference path="../node-builtins.d.ts" />
// Prints the options that /config set for a plugin, as the JSON object of strings that
// `claude plugin configure --values-stdin` reads; `{}` when none is set.
// Usage: node options.mjs <settings.json> <plugin@marketplace>
import { readFileSync } from 'node:fs';

const [settingsPath = '', plugin = ''] = process.argv.slice(2);

/** @param {unknown} value @returns {Record<string, unknown>} */
const asRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

/** @returns {unknown} */
const readSettings = () => {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
};

const options = asRecord(asRecord(asRecord(asRecord(readSettings())['pluginConfigs'])[plugin])['options']);
const values = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)]));
console.log(JSON.stringify(values));
