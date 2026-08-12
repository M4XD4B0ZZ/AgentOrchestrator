/**
 * The construction boundary for execution-lease evidence (V2-07L).
 *
 * ── The mistake this exists to make unmakeable ─────────────────────────────
 *
 * A lease is only worth anything if holding one cannot be *claimed*. A
 * `leaseHeld: true` on a request object, or a freely constructible
 * `{ ownerId: … }`, would be the `authPreflightPassed: true` defect again in a
 * new place — and that one was type-correct, documented as evidence, and
 * completely false. `internal/auth-preflight-evidence.ts` sets out why a plain
 * evidence *object* does not fix it either: TypeScript is structural, so a
 * richer object is the same assertion in a longer spelling.
 *
 * So the same three layers hold here, deliberately of three different kinds:
 *
 *  1. **Nominal typing.** {@link ExecutionLeaseProof} carries a `#private`
 *     field, so no object literal and no structurally identical class is
 *     assignable to it.
 *  2. **A runtime check**, because no type system stops
 *     `x as unknown as ExecutionLeaseEvidence`. Every consumption point is an
 *     `instanceof` gate (`core/execution-lease-evidence.ts`), so a cast buys a
 *     caller a refusal rather than a run.
 *  3. **Reachability**, enforced by a test. The mint lives here, and
 *     `tests/v2-07l-execution-lease.test.ts` pins that exactly one module in
 *     `src/` imports it: `lease/execution-lease.ts`, the module that performs
 *     the exclusive create.
 *
 * ── What this artefact is, and what it is not ──────────────────────────────
 *
 * It is proof that **this process performed the exclusive create** that claimed
 * the lease file named by {@link ExecutionLeaseProof.leasePath}. That is all,
 * and the distinction matters: it is not proof that the lease is still held.
 * A file can be removed underneath its owner — by an operator breaking a lease
 * they believed stale, by a stray delete, by a wiped `.git`. So the artefact is
 * the *ticket*, and `verifyExecutionLeaseHeld` is what asks whether the ticket
 * is still good; the driver re-asks it every iteration for the same reason it
 * re-reconciles every iteration.
 *
 * ── The nonce is an identity, not a secret ─────────────────────────────────
 *
 * It is written into the lease file, so anyone who can read the file can read
 * it. That is fine and is the point: it is what lets the rightful owner tell
 * *its own* lease from a successor's that happens to sit at the same path, and
 * comparison is therefore ordinary equality rather than a constant-time one. A
 * party that can read the lease file can also delete it, so there is no attack
 * the nonce could defend against that its location does not already concede.
 */

import { isAbsolute } from 'node:path';

/** 32 random bytes, hex-encoded. The identity of one claim on one lease file. */
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Every artefact the mint has produced, and nothing else.
 *
 * The whole authority of the type rests on this set, so it is worth being exact
 * about why it exists rather than a cheaper check. Three have been tried:
 *
 *  1. `instanceof` — walks a prototype chain, and `Object.create` hands anybody
 *     that prototype. Forged with no imports.
 *  2. `#nonce in value` — true for anything the constructor built, and the
 *     constructor is reachable from any genuine artefact through
 *     `Object.getPrototypeOf(evidence).constructor`. Forged with no imports.
 *  3. this set — not reachable from an instance, from the prototype, or from the
 *     class. Re-deriving `ExecutionLeaseProof` by any route produces objects
 *     that are simply not in it.
 *
 * A `WeakSet` rather than a field on the object, because every field an object
 * carries is a field an attacker who can construct one can carry too.
 */
const MINTED = new WeakSet<object>();

/**
 * `MINTED.has`, captured at module load.
 *
 * The class is frozen so that `ExecutionLeaseProof.holds = () => true` cannot
 * disable the gate. A review pointed out that the same move survives one level
 * down: `MINTED.has(value)` resolves through `WeakSet.prototype` at call time,
 * so `WeakSet.prototype.has = () => true` anywhere in the process flips it.
 *
 * No authority was gained — the `#` fields act as a second brand and every
 * consumer failed closed — but a gate that can be switched off is not a gate,
 * and binding it costs one line.
 */
const isMinted: (value: object) => boolean = WeakSet.prototype.has.bind(MINTED) as (
  value: object,
) => boolean;

/**
 * The artefact. Minted only by {@link mintExecutionLeaseEvidence}, and only for
 * a claim that really performed the exclusive create.
 *
 * The `#nonce` field is what makes the type nominal, and it is the whole
 * mechanism: remove it and this class becomes structurally equal to
 * `{ leasePath: string }`, which a caller can write down.
 */
export class ExecutionLeaseProof {
  readonly #nonce: string;
  readonly #leasePath: string;

  constructor(nonce: string, leasePath: string) {
    this.#nonce = nonce;
    this.#leasePath = leasePath;
  }

  /**
   * Whether `value` really carries this class's private field.
   *
   * ── Why this is not `instanceof`, and why there are no instance members ───
   *
   * `instanceof` walks the prototype chain, and a prototype is something any
   * caller can hand to `Object.create`. An adversarial review built working
   * evidence out of one genuine artefact and no imports at all:
   *
   *     Object.create(Object.getPrototypeOf(realEvidence), {
   *       leasePath:            { value: someOtherLeasePath },
   *       matchesRecordedNonce: { value: () => true },
   *     })
   *
   * That value passed `instanceof`, satisfied every gate, advanced durable state
   * and released a rightful owner's lease. Own properties shadow a prototype
   * getter and method, so the `#nonce` this class is built around never had to
   * exist — nothing ever read it.
   *
   * No reachability test can catch that: it imports nothing. So the artefact
   * stops exposing anything to shadow. There is no `leasePath` getter and no
   * `matchesRecordedNonce` method; the two statics below read the private fields
   * directly, and `#nonce in value` is true only for an object that really went
   * through this constructor. `Object.create` does not copy private fields, so
   * the forgery above now fails at the gate.
   */
  static holds(value: unknown): value is ExecutionLeaseProof {
    // Membership of a module-private registry, **not** a property of the value.
    //
    // `#nonce in value` was the previous answer and it is not enough: the class
    // is reachable from any genuine artefact as
    // `Object.getPrototypeOf(evidence).constructor`, with no import of anything,
    // and calling it installs a real `#nonce`. A reviewer forged full write
    // authority over a live repository that way and deleted its lease, across
    // process boundaries, three times out of three.
    //
    // The private field is a fact about *how an object was built*; what this gate
    // has to answer is *whether the mint built it*. Those came apart the moment
    // the constructor became reachable, and no property of the object can close
    // that — an attacker who can call the constructor can produce any property.
    // A registry the mint alone writes to cannot be reached from an instance at
    // all, so re-deriving the class buys nothing.
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * The one file this evidence is about.
   *
   * A static reading the private field, not a getter — see {@link holds}. It is
   * carried on the artefact rather than re-derived by the release path so that a
   * caller cannot point a release at a lease it did not take: there is no
   * argument for "which lease", because the proof already says.
   */
  static leasePathOf(proof: ExecutionLeaseProof): string {
    return proof.#leasePath;
  }

  /**
   * Whether `recorded` is the nonce this claim wrote.
   *
   * Takes `unknown` because the value comes from a parsed file, and a proof that
   * only worked on already-validated input would be checking the wrong thing.
   */
  static matchesNonce(proof: ExecutionLeaseProof, recorded: unknown): boolean {
    return typeof recorded === 'string' && recorded === proof.#nonce;
  }
}

/**
 * Mints evidence for a claim that performed the exclusive create.
 *
 * Both inputs are re-validated here rather than trusted from the caller, for
 * the same reason the auth mint re-derives its verdict: the one function that
 * can produce the artefact is the wrong place to take anything on trust. A
 * malformed nonce or a non-absolute path mints nothing.
 */
export function mintExecutionLeaseEvidence(
  nonce: string,
  leasePath: string,
): ExecutionLeaseProof | null {
  if (!NONCE_PATTERN.test(nonce)) return null;
  // Absolute, and checked here rather than described here. This said "a
  // non-absolute path mints nothing" while testing only for emptiness, which is
  // the shape of comment that survives the check it describes being removed. A
  // relative path is not a location — `core/path-identity.ts` sets out why — and
  // the repository-scoped verification compares this value against a derived
  // absolute one, so a relative path could never match anything.
  if (leasePath.trim().length === 0 || !isAbsolute(leasePath)) return null;
  const proof = new ExecutionLeaseProof(nonce, leasePath);
  // The only line in the codebase that admits anything to the registry. Every
  // other route to the constructor — and there is at least one that needs no
  // import — produces an object this gate does not recognise.
  MINTED.add(proof);
  return proof;
}

// The class object and its prototype are frozen, and the prototype's back
// reference to the constructor is removed.
//
// Neither is what makes the type safe — the registry above is — and both are
// cheap, so they are done anyway to close the routes a reviewer actually used.
// `Object.getPrototypeOf(evidence).constructor` is how the class was reached
// without importing it, and `ExecutionLeaseProof.holds = () => true` is how the
// gate was disabled process-wide once it had been.
Reflect.deleteProperty(ExecutionLeaseProof.prototype, 'constructor');
Object.freeze(ExecutionLeaseProof.prototype);
Object.freeze(ExecutionLeaseProof);
