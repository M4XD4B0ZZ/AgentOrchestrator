#!/usr/bin/env node
/**
 * Regenerates `schemas/task-state.schema.json` from the Zod contract.
 * Run via `npm run schema:generate`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { renderTaskStateJsonSchema } from '../src/core/json-schema.js';
import { TASK_STATE_SCHEMA_FILE } from '../src/config/paths.js';

const contents = renderTaskStateJsonSchema();
mkdirSync(dirname(TASK_STATE_SCHEMA_FILE), { recursive: true });
writeFileSync(TASK_STATE_SCHEMA_FILE, contents, 'utf8');

process.stdout.write(`Wrote ${TASK_STATE_SCHEMA_FILE} (${contents.length} bytes)\n`);
