/**
 * Where the unattended-publication authorisation store is, and nothing else.
 *
 * These three values lived in `deliver/head-publication-authorisation-store.ts`
 * until V4 slice 15 needed to *read* the store, and they were moved rather than
 * copied — for the reason `internal/delivery-ref-grammar.ts` already writes down
 * about its own move, one authority earlier:
 *
 * > A second authority importing it *for a regular expression* would have
 * > widened that set without widening what anybody can do — the pin would have
 * > had to be loosened, and a loosened pin measures less.
 *
 * The same shape applies here with the direction reversed. The store module is
 * the **writer**: its value-import closure carries the exclusive `mkdir`, the
 * crash-safe replace and the `rename` that publishes bytes. A read-only listing
 * that had to import it to learn a directory name would have pulled every one of
 * those into its own closure, and "this command cannot create anything" would
 * have stopped being a fact about the import graph and become a promise about
 * care.
 *
 * So the location sits here, in a module that writes nothing, creates nothing
 * and imports no writer. The store re-exports all three, so slice 14's callers
 * and its suite are unchanged.
 *
 * What this module deliberately does **not** do: it does not create the
 * directory it names, and it does not check that anything is there. A path is a
 * string until somebody looks.
 */

import { join } from 'node:path';

import { orchestratorHome } from '../../config/paths.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../../config/internal/path-provider.js';

/**
 * The directory under the orchestrator home that holds the records.
 *
 * A directory of its own, following the rule this build already made structural
 * after reproducing the alternative: a new kind of record gets its own
 * directory rather than its own name inside a shared one.
 *
 * Named for what it holds — authorisations — and deliberately not for
 * publications. A directory called `head-publications` would make its own
 * existence a claim that things were published, and the records inside it assert
 * nothing of the sort.
 */
export const HEAD_PUBLICATION_AUDIT_DIR_NAME = 'head-publication-authorisations';

/** The one file name inside an event directory. No alternative spelling. */
export const HEAD_PUBLICATION_AUDIT_FILE_NAME = 'authorisation.json';

/**
 * The store root. A pure function of the OS user identity.
 *
 * It resolves the profile — one `os.userInfo()` on first use, memoised by
 * `config/internal/trusted-profile.ts` — and creates nothing. A root that is not
 * there is a machine that has authorised no unattended publication, which is a
 * reading and not an error.
 */
export function headPublicationAuditRoot(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), HEAD_PUBLICATION_AUDIT_DIR_NAME);
}
