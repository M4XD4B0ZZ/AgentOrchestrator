/**
 * This file is Windows-only, by decision, and carries no `it.runIf(process.platform
 * === 'win32')` guard anywhere in it — unlike its sibling
 * `tests/v2-07lr-lease-recovery.test.ts`, which guards its Windows-specific cases that
 * way.
 *
 * The two files differ because what they are testing differs. The sibling's guarded
 * cases exercise a Windows-specific *code path* inside a build that otherwise still
 * runs elsewhere, so skipping them on another platform reports `skipped`, honestly,
 * rather than a false pass. This file tests the platform contract itself: under the
 * binding V2 Windows/NTFS-first contract, this build refuses to run at all off
 * Windows, so guarding this suite for that platform would be repairing, in the test
 * runner, the exact portability this slice exists to remove from the product. A test
 * for "what happens on Linux" would be a test for a configuration this repository has
 * decided not to support — see one of them assert that outright, rather than
 * conditionally: `expect(process.platform).toBe('win32')`, below.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  evaluateRuntimeSupport,
  parseNodeMajor,
  SUPPORTED_NODE_MAJORS,
} from '../src/platform/runtime-support.js';
import { EXIT_RUNTIME_UNSUPPORTED } from '../src/cli/run-exit-codes.js';
import { renderRuntimeRefusal } from '../src/cli/runtime-gate.js';
import { line } from '../src/cli/render-attended-run.js';
import {
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
} from '../src/lease/execution-lease.js';
import {
  LEASE_ACQUIRE_SENTENCES,
  LEASE_STATE_SENTENCES,
  renderLeaseStatus,
} from '../src/cli/render-lease.js';
import { assessLeaseRecovery } from '../src/lease/lease-recovery.js';

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/**
 * Assert that one declaration of the supported Node majors is exactly
 * `SUPPORTED_NODE_MAJORS` — and, when it is not, say WHICH declaration
 * disagrees and in WHICH direction.
 *
 * `expect(found).toEqual(expected)` reports two arrays and leaves the rest to
 * the reader. That is not enough here, because the drift arrives from either
 * side — the constant is widened and a declaration is not, or a declaration is
 * widened and the constant is not — and the two are repaired in opposite
 * directions. A failure that does not name the odd source out sends the reader
 * to re-derive it by hand across four files, which is the work this test was
 * supposed to have already done.
 */
function expectDeclaresSupportedMajors(source: string, declared: readonly number[]): void {
  const constant = ascending([...SUPPORTED_NODE_MAJORS]);
  const found = ascending(declared);
  if (found.length === constant.length && found.every((major, index) => major === constant[index])) {
    return;
  }

  const list = (majors: readonly number[]): string =>
    majors.length === 0 ? '(none)' : majors.join(', ');

  throw new Error(
    [
      `${source} and SUPPORTED_NODE_MAJORS declare different Node majors.`,
      '',
      `  ${source}: ${list(found)}`,
      `  SUPPORTED_NODE_MAJORS (src/platform/runtime-support.ts): ${list(constant)}`,
      '',
      `  named here but not supported by the constant: ${list(found.filter((major) => !constant.includes(major)))}`,
      `  supported by the constant but not named here: ${list(constant.filter((major) => !found.includes(major)))}`,
      '',
      'One of the two was changed without the other. Whichever it was, the',
      'supported set is declared in four places and all four have to agree:',
      'SUPPORTED_NODE_MAJORS, `engines.node` in package.json, the CI matrix in',
      ".github/workflows/verify.yml, and README.md's `{...}` set notation.",
    ].join('\n'),
  );
}

describe('the runtime support decision is a whitelist, not a floor', () => {
  // The two rows that matter most are 23 and 25. `includes(major)` and
  // `major >= 22` agree on 21, 22 and 24 and disagree ONLY here, so a suite
  // without them passes against an implementation that silently reverted to a
  // floor — and the contract would then be wider than the document claims with
  // every test still green.
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ['win32', 'v21.7.3', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'v22.11.0', null],
    ['win32', 'v23.5.0', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'v24.18.1', null],
    ['win32', 'v25.0.0', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'not-a-version', 'RUNTIME_NODE_VERSION_UNREADABLE'],
    ['win32', '', 'RUNTIME_NODE_VERSION_UNREADABLE'],
  ];

  for (const [platform, version, expected] of cases) {
    it(`${platform} ${version || '<empty>'} -> ${expected ?? 'supported'}`, () => {
      const result = evaluateRuntimeSupport(platform, version);
      if (expected === null) {
        expect(result.supported).toBe(true);
        return;
      }
      expect(result.supported).toBe(false);
      if (result.supported) return;
      expect(result.code).toBe(expected);
    });
  }

  // Driven at BOTH supported majors so a platform refusal cannot come out of
  // the Node check by accident.
  for (const platform of ['linux', 'darwin', 'freebsd', 'android']) {
    for (const version of ['v22.11.0', 'v24.18.1']) {
      it(`${platform} ${version} -> RUNTIME_PLATFORM_UNSUPPORTED`, () => {
        const result = evaluateRuntimeSupport(platform, version);
        expect(result.supported).toBe(false);
        if (result.supported) return;
        expect(result.code).toBe('RUNTIME_PLATFORM_UNSUPPORTED');
      });
    }
  }

  it('refuses the platform before it reads the version at all', () => {
    // Otherwise an unreadable version on POSIX would report a Node problem to
    // an operator whose actual problem is the operating system.
    const result = evaluateRuntimeSupport('linux', 'not-a-version');
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.code).toBe('RUNTIME_PLATFORM_UNSUPPORTED');
  });

  it('states the supported set as exactly two majors', () => {
    expect([...SUPPORTED_NODE_MAJORS]).toEqual([22, 24]);
  });

  it('parses a major only from a well-formed version', () => {
    expect(parseNodeMajor('v24.18.1')).toBe(24);
    expect(parseNodeMajor('24.18.1')).toBe(24);
    expect(parseNodeMajor('  v22.11.0  ')).toBe(22);
    expect(parseNodeMajor('v24')).toBeNull();
    expect(parseNodeMajor('')).toBeNull();
  });

  it('carries a detail that names what was found and what is supported', () => {
    // The refusal message is the diagnosis, so the detail may not be generic.
    const result = evaluateRuntimeSupport('win32', 'v25.0.0');
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.detail).toContain('25');
    expect(result.detail).toContain('22');
    expect(result.detail).toContain('24');
  });
});

describe('the whitelist has one definition, not four unrelated ones', () => {
  // Four places assert "SUPPORTED_NODE_MAJORS, the CI matrix, engines.node and
  // README are the same set" - the module doc in runtime-support.ts, the
  // workflow's own comment, package.json, and README. Before these tests,
  // nothing read the other three: the only check was
  // `expect([...SUPPORTED_NODE_MAJORS]).toEqual([22, 24])` above, which stays
  // true, and every claim just named becomes false, if a member is added to
  // the array without also touching `package.json`, the workflow or README.
  //
  // These tests read the real files and derive the expectation from
  // `SUPPORTED_NODE_MAJORS` itself - never from a second hardcoded [22, 24] -
  // so they catch the drift from BOTH sides, which is the point: a member
  // added to the constant and not to CI is an enforced claim nobody measures,
  // and a member added to CI and not to the constant is a measured claim the
  // build refuses to honour. The two are repaired in opposite directions, so
  // the failure names which source is the odd one out rather than printing two
  // arrays and leaving the reader to work it out (`expectDeclaresSupportedMajors`).

  it("package.json's engines.node names exactly SUPPORTED_NODE_MAJORS", () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: unknown };
    };
    const raw = pkg.engines?.node;
    expect(typeof raw).toBe('string');

    // "22.x || 24.x" -> [22, 24]. A token that is not "<digits>.x" fails loudly
    // rather than being silently skipped, so a reformatted engines.node does
    // not make this check pass by accident.
    const majors = String(raw)
      .split('||')
      .map((token) => token.trim())
      .map((token) => {
        const match = /^(\d+)\.x$/.exec(token);
        if (match?.[1] === undefined) {
          throw new Error(`engines.node token is not "<major>.x": ${JSON.stringify(token)}`);
        }
        return Number.parseInt(match[1], 10);
      });

    expectDeclaresSupportedMajors('`engines.node` in package.json', majors);
  });

  it('the CI matrix measures exactly SUPPORTED_NODE_MAJORS, no more and no fewer', () => {
    const workflowText = readFileSync(
      new URL('../.github/workflows/verify.yml', import.meta.url),
      'utf8',
    );
    const workflow = parseYaml(workflowText) as {
      jobs?: { verify?: { strategy?: { matrix?: { node?: unknown } } } };
    };
    const matrixNode = workflow.jobs?.verify?.strategy?.matrix?.node;
    expect(Array.isArray(matrixNode)).toBe(true);

    expectDeclaresSupportedMajors(
      'the `verify` matrix in .github/workflows/verify.yml',
      matrixNode as number[],
    );
  });

  // The fourth visible claim, and the only one written for a human: README
  // enumerates the supported majors, and an operator reads that, not the
  // constant. package.json, the workflow and the constant could all move to
  // {22, 24, 26} while README kept saying "22 or 24" - nothing above catches
  // it.
  //
  // This does NOT parse prose, and the draft that did was withdrawn. README
  // used to spell the same set four different ways - "22 or 24", "22 *and*
  // 24", "in `{22, 24}`", "`[22, 24]`" - and reading that reliably needs a
  // parser for English, which fails for the wrong reasons: the section's own
  // "not a floor" bullet legitimately names 23 and 25 as majors this build
  // does NOT support, and any scan for bare 2-digit numbers flags that true
  // sentence as a lie.
  //
  // So README was given ONE form for the claim instead - a braced list in
  // backticks, `{22, 24}` - and says so in its own supported-runtime section,
  // where an editor adding a fifth mention will read it. This test matches
  // that fixed token and nothing else. The two sentence kinds left outside the
  // form are outside it deliberately, and are not claims about the supported
  // set: the rejection example above, and a dated record of what the set was
  // at an earlier slice ("At V2-07P, `[22, 24]`"), which stays true after the
  // set widens and must therefore NOT be rewritten when it does.
  const SUPPORTED_SET_NOTATION = /`\{(\d+(?:\s*,\s*\d+)*)\}`/g;

  const readReadme = (): string => readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('every occurrence of README\'s supported-set notation is exactly SUPPORTED_NODE_MAJORS', () => {
    const readme = readReadme();
    const occurrences = [...readme.matchAll(SUPPORTED_SET_NOTATION)];

    // The floor, and the reason this is not vacuous. "Every occurrence agrees"
    // is trivially true of a document with no occurrences, so a rewording that
    // drops the notation entirely would take the check with it and pass. Zero
    // is a failure here, which sends the editor back to either restore the
    // form or replace this anchor deliberately.
    expect(occurrences.length).toBeGreaterThan(0);

    for (const occurrence of occurrences) {
      const capture = occurrence[1];
      if (capture === undefined) {
        throw new Error(`SUPPORTED_SET_NOTATION matched with no capture group: ${occurrence[0]}`);
      }
      const lineNumber = readme.slice(0, occurrence.index).split('\n').length;
      expectDeclaresSupportedMajors(
        `README.md:${lineNumber} ${occurrence[0]}`,
        capture.split(',').map((token) => Number.parseInt(token.trim(), 10)),
      );
    }
  });

  it('the supported-runtime section itself still states the set', () => {
    // A floor scoped to the section that OWNS the contract. The whole-file
    // check above stays green if the only surviving notation is the one in the
    // requirements list at the top of the file, or in the V1 verification
    // boundary far below it - and the section every refusal message sends an
    // operator to would then name no majors at all.
    const readme = readReadme();
    const startMarker = '## Supported runtime';
    const startIndex = readme.indexOf(startMarker);
    expect(startIndex).toBeGreaterThan(-1);

    const afterHeading = readme.slice(startIndex + startMarker.length);
    const nextHeading = /^## /m.exec(afterHeading);
    const section = nextHeading === null ? afterHeading : afterHeading.slice(0, nextHeading.index);

    expect([...section.matchAll(SUPPORTED_SET_NOTATION)].length).toBeGreaterThan(0);
  });
});

describe('the runtime refusal is the diagnosis', () => {
  const refusal = (platform: string, version: string): string => {
    const support = evaluateRuntimeSupport(platform, version);
    expect(support.supported).toBe(false);
    if (support.supported) throw new Error('unreachable');
    return renderRuntimeRefusal(support, platform, version);
  };

  it('names what was found, on both axes', () => {
    const text = refusal('linux', 'v22.11.0');
    expect(text).toContain('linux');
    expect(text).toContain('v22.11.0');
  });

  it('names the supported configuration', () => {
    const text = refusal('linux', 'v22.11.0');
    expect(text).toContain('Windows');
    expect(text).toContain('22');
    expect(text).toContain('24');
  });

  it('says that nothing was started', () => {
    // An operator who cannot tell whether the tool half-ran will go looking for
    // state that does not exist.
    expect(refusal('linux', 'v22.11.0')).toContain('Nothing was started');
  });

  it('tells the operator what still works here', () => {
    const text = refusal('win32', 'v25.0.0');
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });

  it('carries the code and the detail from the decision', () => {
    expect(refusal('win32', 'v25.0.0')).toContain('RUNTIME_NODE_UNSUPPORTED');
    expect(refusal('win32', 'nonsense')).toContain('RUNTIME_NODE_VERSION_UNREADABLE');
  });

  it('ends with a newline, so a terminal does not eat the last line', () => {
    expect(refusal('linux', 'v22.11.0').endsWith('\n')).toBe(true);
  });

  it('uses an exit code no run outcome uses', () => {
    expect(EXIT_RUNTIME_UNSUPPORTED).toBe(6);
  });
});

describe('the gate does not disturb the supported path', () => {
  it('lets a command action run on this (supported) runtime', async () => {
    // The in-process positive control. Its counterpart — that an action does
    // NOT run on an unsupported runtime — cannot be measured in-process,
    // because the gate terminates the process; that half is
    // tests/dist-artifact/runtime-gate-dist-artifact.mjs.
    expect(process.platform).toBe('win32');
    const { buildProgram } = await import('../src/cli/index.js');
    const program = buildProgram();
    // Commander would otherwise call process.exit on a usage error.
    program.exitOverride();

    // `process.stdout.write`, not `configureOutput`: `lease-command.ts` writes
    // its report through the former directly, so a Commander output hook sees
    // none of it and this control would pass against a gate that blocked the
    // action entirely.
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    // The action sets `process.exitCode`; left set, it becomes vitest's own
    // exit code and a fully passing run reports failure.
    const previousExitCode = process.exitCode;
    try {
      // `from: 'user'` means the array carries NO node/script prefix.
      await program.parseAsync(['lease', 'status', '--repository', 'no-such-repository'], {
        from: 'user',
      });
    } finally {
      spy.mockRestore();
      process.exitCode = previousExitCode;
    }

    // The action ran. Either marker proves it: both are written by
    // `lease-command.ts` itself, downstream of the hook.
    const output = written.join('');
    expect(output.length).toBeGreaterThan(0);
    expect(/could not be resolved|Lease/.test(output)).toBe(true);
  });
});

describe('the lease location refuses network and device paths, and says which', () => {
  const derive = (key: string) =>
    deriveExecutionLeaseLocation({ gitCommonDir: key, root: 'C:\\repo', id: 'shape' });

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['\\\\server\\share\\repo\\.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['//server/share/repo/.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['\\\\?\\UNC\\server\\share\\repo\\.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['\\\\?\\unc\\server\\share\\repo\\.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['\\\\.\\PhysicalDrive0', 'LEASE_LOCATION_DEVICE_NAMESPACE'],
    ['\\\\.\\C:\\repo\\.git', 'LEASE_LOCATION_DEVICE_NAMESPACE'],
    ['\\repo\\.git', 'LEASE_LOCATION_UNSUITABLE'],
    ['/repo/.git', 'LEASE_LOCATION_UNSUITABLE'],
    ['\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\r', 'LEASE_LOCATION_UNSUITABLE'],
  ];

  for (const [key, code] of refused) {
    it(`${key} -> ${code}`, () => {
      const derived = derive(key);
      expect(derived.ok).toBe(false);
      if (derived.ok) return;
      // The specific code, never merely `ok === false`: a refusal that
      // misdescribes itself is worse than a verbose one, and the whole point of
      // splitting these classes is that they are told apart.
      expect(derived.code).toBe(code);
    });
  }

  // The control against an over-broad refusal. Without it, an implementation
  // that refuses every Windows path passes every case above. This is also the
  // ACCEPTED LIMIT, both drive-letter forms included: a drive letter can be a
  // mapped network share, in the plain form and the extended-length form
  // alike, and this loop accepting both is not a claim that either volume is
  // local — that non-claim is what the sentence tests below pin, in the
  // refusal text itself, not here.
  for (const key of ['C:\\repo\\.git', 'c:/repo/.git', '\\\\?\\C:\\repo\\.git']) {
    it(`${key} is still accepted`, () => {
      expect(derive(key).ok).toBe(true);
    });
  }
});

describe('lease status describes the refusal it actually met', () => {
  const inspect = (key: string) =>
    inspectRepositoryExecutionLease({ gitCommonDir: key, root: 'C:\\repo', id: 'shape' });

  it('reports a network path as such, not as "no location could be derived"', () => {
    expect(inspect('\\\\server\\share\\repo\\.git').state).toBe('LOCATION_NETWORK_UNSUPPORTED');
  });

  it('reports a device path as such', () => {
    expect(inspect('\\\\.\\PhysicalDrive0').state).toBe('LOCATION_DEVICE_NAMESPACE');
  });

  it('still reports an underivable location as underivable', () => {
    expect(inspect('\\repo\\.git').state).toBe('LOCATION_UNSUITABLE');
  });

  // `renderLeaseStatus` used to fill the `Path` field from `path === ''`
  // alone, so a UNC or device repository printed "Path: not derivable" one
  // line under a sentence that says the opposite: "This is a refusal, not a
  // failure to understand the path." A substring check on one field is not
  // enough to pin that: it would pass against an empty `Path` line, or any
  // other wrong-but-different text. These three compare the COMPLETE
  // operator-visible report - every field, byte for byte - so a contradiction
  // anywhere between the `Lease` sentence and the `Path` line is caught, not
  // only the one this review found. Every literal below is copied from the
  // sentence constants and from `pathField` independently, by hand, rather
  // than imported from either - importing them would let the test and the
  // implementation drift together and still agree with each other.
  const REPORT_FIELDS = {
    revision: 'none',
    object: 'none',
    ownerPid: 'none',
    liveness: 'UNKNOWABLE',
    livenessSentence: '  no owner is recorded, so nothing can be said about one.',
    run: 'none',
    block: 'none',
    acquired: 'unknown',
  };

  const expectedReport = (state: string, sentence: string, pathText: string): string =>
    [
      '',
      line('Lease', state),
      `  ${sentence}`,
      line('Path', pathText),
      line('Revision', REPORT_FIELDS.revision),
      line('Object', REPORT_FIELDS.object),
      line('Owner pid', REPORT_FIELDS.ownerPid),
      line('Liveness', REPORT_FIELDS.liveness),
      REPORT_FIELDS.livenessSentence,
      line('Run', REPORT_FIELDS.run),
      line('Block', REPORT_FIELDS.block),
      line('Acquired', REPORT_FIELDS.acquired),
    ].join('\n') + '\n\n';

  it('prints the complete network-refusal report, with no contradiction between the sentence and the Path line', () => {
    const actual = renderLeaseStatus(inspect('\\\\server\\share\\repo\\.git'));
    const expected = expectedReport(
      'LOCATION_NETWORK_UNSUPPORTED',
      'This repository is on a UNC or network path, which V2 does not support, so it has no\n' +
        '  lease location. This is a refusal, not a failure to understand the path.',
      'refused (UNC or network path)',
    );
    expect(actual).toBe(expected);
  });

  it('prints the complete device-namespace report, with no contradiction between the sentence and the Path line', () => {
    const actual = renderLeaseStatus(inspect('\\\\.\\PhysicalDrive0'));
    const expected = expectedReport(
      'LOCATION_DEVICE_NAMESPACE',
      'This repository path is in the Windows device namespace, which is not a place a lease\n' +
        '  can be kept.',
      'refused (Windows device path)',
    );
    expect(actual).toBe(expected);
  });

  it('prints the complete underivable-location report, and only this one still says "not derivable"', () => {
    const actual = renderLeaseStatus(inspect('\\repo\\.git'));
    const expected = expectedReport(
      'LOCATION_UNSUITABLE',
      "This repository's Git common directory has no usable lease location: either none\n" +
        '  could be derived from it, or its shape is one this build has not verified.',
      'not derivable',
    );
    expect(actual).toBe(expected);
  });
});

describe('every new code carries its own sentence', () => {
  it('names the network refusal as network storage outside the contract', () => {
    const sentence = LEASE_ACQUIRE_SENTENCES.LEASE_LOCATION_NETWORK_UNSUPPORTED;
    expect(sentence).toMatch(/UNC|network/i);
    expect(sentence).not.toContain('No lease location could be derived');
  });

  it('names the device refusal without calling it UNC', () => {
    const sentence = LEASE_ACQUIRE_SENTENCES.LEASE_LOCATION_DEVICE_NAMESPACE;
    expect(sentence).toMatch(/device/i);
    expect(sentence).not.toMatch(/UNC/);
  });

  it('gives each new inspection state a distinct sentence', () => {
    const sentences = [
      LEASE_STATE_SENTENCES.LOCATION_UNSUITABLE,
      LEASE_STATE_SENTENCES.LOCATION_NETWORK_UNSUPPORTED,
      LEASE_STATE_SENTENCES.LOCATION_DEVICE_NAMESPACE,
    ];
    expect(new Set(sentences).size).toBe(3);
  });
});

describe('lease recovery classifies a network or device path as such, never as the crash-window artefact', () => {
  // `classifyForRecovery` (src/lease/lease-recovery.ts) switches on
  // `inspection.state`. Before this test existed, the two new location states
  // matched no case in that switch, fell through into the liveness switch, and
  // — because `inspection()` defaults an undetermined `liveness` to
  // `UNKNOWABLE` — came out as `NO_OWNER_RECORDED`: the classification
  // documented as "the artefact a crash between the exclusive create and the
  // record write leaves behind". For a UNC or device path nothing was ever
  // created there at all, so that is the same misdescription this task exists
  // to delete, reintroduced one module over.
  it('classifies a network path as the network refusal, not as an unowned crash artefact', () => {
    const assessed = assessLeaseRecovery({
      gitCommonDir: '\\\\server\\share\\repo\\.git',
      root: 'C:\\repo',
      id: 'network',
    });
    expect(assessed.classification).toBe('LOCATION_NETWORK_UNSUPPORTED');
  });

  it('classifies a device path as the device refusal, not as an unowned crash artefact', () => {
    const assessed = assessLeaseRecovery({
      gitCommonDir: '\\\\.\\PhysicalDrive0',
      root: 'C:\\repo',
      id: 'device',
    });
    expect(assessed.classification).toBe('LOCATION_DEVICE_NAMESPACE');
  });
});
