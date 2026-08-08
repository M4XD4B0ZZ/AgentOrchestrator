#!/usr/bin/env node
/**
 * Regenerates the checked-in JSON Schema documents from their Zod contracts:
 *
 *  - `schemas/task-state.schema.json`   ← `src/core/task-state.ts`
 *  - `schemas/repo-profile.schema.json` ← `src/repo/repo-profile.ts`
 *
 * Run via `npm run schema:generate`. Each contract has exactly one Zod source;
 * a drift test compares the emitted bytes with the file on disk, so neither
 * document is ever maintained by hand.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { renderTaskStateJsonSchema } from '../src/core/json-schema.js';
import { renderRepoProfileJsonSchema } from '../src/repo/json-schema.js';
import { REPO_PROFILE_SCHEMA_FILE, TASK_STATE_SCHEMA_FILE } from '../src/config/paths.js';

const documents: ReadonlyArray<readonly [string, () => string]> = [
  [TASK_STATE_SCHEMA_FILE, renderTaskStateJsonSchema],
  [REPO_PROFILE_SCHEMA_FILE, renderRepoProfileJsonSchema],
];

for (const [file, render] of documents) {
  const contents = render();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  process.stdout.write(`Wrote ${file} (${contents.length} bytes)\n`);
}
