/**
 * DASHBOARD-001 slice 4 — the AO Manager page, view model half.
 *
 * Two halves, deliberately separated. Everything in this file is PURE: a value
 * in, a string out, no DOM, no network and no clock. That is not an
 * abstraction for its own sake — this repository has seven dependencies and no
 * DOM in its test runner, so a view model that renders to a STRING is the whole
 * difference between a UI that is pinned and one that is hoped for. The polling
 * loop and the DOM glue land in a later task of this slice and will sit below
 * this namespace; rendering is then a single `innerHTML` assignment.
 *
 * The page never asserts anything the snapshot does not carry. Three rules do
 * most of that work, and each has a test that fails without it:
 *  - a lease proves activity only when the owner is known to answer;
 *  - the task AO is on is inferred, and says so;
 *  - a reading that failed is never rendered as good news.
 *
 * Two mechanical constraints shape the source. It is served to a browser
 * exactly as it sits on disk — no bundler, no transpiler — so it is ES5-
 * compatible script in an IIFE with no import of any kind. And every value the
 * snapshot carries reaches `innerHTML`, so every one of them goes through
 * `escapeHtml` on the way. The page's CSP carries no `'unsafe-inline'` and
 * would block an injected `<script>` or an inline handler, but that is the
 * second layer; a snapshot string that rewrites the layout needs no script to
 * do damage.
 */
(function (global) {
  'use strict';

  /* ── freshness: the client's own clock ──────────────────────────────────── */

  var LIVE_MS = 20000;
  var STALE_MS = 60000;

  /**
   * How current the page is, from the time of its own last successful fetch.
   *
   * Deliberately not derived from `snapshot.observedAt`: that instant is
   * excluded from the revision, so an idle, healthy machine legitimately
   * answers one unchanged snapshot forever. Derived AGES are a different
   * question and do use `observedAt` — see `recordedAge`.
   */
  function classifyFreshness(lastGoodAtMs, nowMs) {
    // `null` is "no contact in this session" — the cold offline launch. It is
    // OFFLINE and never LIVE: a page that has never reached the Manager must
    // not open claiming otherwise.
    if (lastGoodAtMs === null || lastGoodAtMs === undefined) return 'OFFLINE';
    var age = nowMs - lastGoodAtMs;
    if (age < LIVE_MS) return 'LIVE';
    if (age <= STALE_MS) return 'STALE';
    return 'OFFLINE';
  }

  /* ── escaping ───────────────────────────────────────────────────────────── */

  var HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  /**
   * The five characters that change how markup parses.
   *
   * `null` and `undefined` render as nothing rather than as the words "null"
   * and "undefined": every structural absence in the public contract is handled
   * by an explicit branch at the call site, so a `null` arriving here is a
   * defect in a caller and printing it in the operator's face teaches nothing.
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (character) {
      return HTML_ESCAPES[character];
    });
  }

  /* ── small internal helpers ─────────────────────────────────────────────── */

  function owns(table, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
  }

  function items(value) {
    return Object.prototype.toString.call(value) === '[object Array]' ? value : [];
  }

  /* ── the lease, and what it does not prove ──────────────────────────────── */

  /**
   * A held lease, by whether its recorded owner still answers.
   *
   * `NOT_FOUND` is the row that matters and the one an earlier draft got wrong
   * by folding it into "unknown". A held lease whose recorded owner is GONE is
   * a STALE lease — an operator fact requiring action — and it is not the same
   * as a probe that could not answer.
   */
  var HELD_WORDING = {
    ALIVE: 'Repository activity: confirmed',
    NOT_FOUND: 'Lease held · recorded owner is gone',
    UNDETERMINED: 'Lease held · owner liveness could not be determined',
    UNKNOWABLE: 'Lease held · no owner recorded'
  };

  /**
   * The lease reading, as a sentence that claims exactly what it observed.
   *
   * Total over the public lease union crossed with owner liveness. `FREE` is
   * never rendered as "idle": that would claim AO is up and doing nothing, and
   * this build cannot know it — AO writes no pidfile, no heartbeat and no
   * daemon record, so an absent lease is not evidence that nothing is running.
   *
   * A liveness value this build does not recognise is echoed verbatim rather
   * than mapped onto the nearest known row. The public contract types that
   * field as a plain string, so a newer writer can widen it, and guessing which
   * of the four it meant is how "gone" quietly becomes "unknown" again.
   *
   * Returns plain text. Every caller escapes it on the way into markup.
   */
  function leaseWording(lease) {
    if (!lease || typeof lease.reading !== 'string') return 'Lease reading absent';
    if (lease.reading === 'FREE') return 'No lease held';
    if (lease.reading === 'HELD') {
      if (owns(HELD_WORDING, lease.ownerLiveness)) return HELD_WORDING[lease.ownerLiveness];
      return 'Lease held · owner liveness: ' + lease.ownerLiveness;
    }
    if (lease.reading === 'OTHER') return 'Lease state: ' + lease.state;
    if (lease.reading === 'NOT_OBSERVED') return 'Lease could not be read — ' + lease.why;
    return 'Lease reading: ' + lease.reading;
  }

  /* ── naming a repository ────────────────────────────────────────────────── */

  /**
   * What to call a repository.
   *
   * An UNUSABLE profile carries a code and no `repositoryId`. Such a repository
   * is never omitted — a repository AO cannot identify is itself
   * operator-relevant — and its `repositoryKey` is a digest that is never
   * silently substituted for a name.
   */
  function repositoryName(repository) {
    var profile = repository ? repository.profile : null;
    if (profile && profile.reading === 'DECLARED') return profile.repositoryId;
    if (profile && profile.reading === 'UNUSABLE') {
      return 'Unnamed repository · profile unusable (' + profile.code + ')';
    }
    return 'Unnamed repository · profile reading absent';
  }

  /* ── counts, never mixed across dimensions ──────────────────────────────── */

  function countDeclared(repository, declaration) {
    var tasks = items(repository ? repository.tasks : null);
    var total = 0;
    for (var index = 0; index < tasks.length; index += 1) {
      if (tasks[index].declaration === declaration) total += 1;
    }
    return total;
  }

  /**
   * Completion, with both of its degenerate cases spelled out.
   *
   * The numerator counts `tasks[]` whose declaration is `DONE`; the denominator
   * is `declaredTasks.count`, and never `tasks.length`, which also holds
   * runtime-only rows whose declaration is `NOT_DECLARED`.
   *
   * A task whose declaration could not be read is NAMED rather than folded into
   * the remainder, and when the plan itself could not be read no fraction is
   * printed at all — every declaration is undetermined in that case, so a
   * denominator would be an invention.
   */
  function completionLine(repository) {
    var declared = repository ? repository.declaredTasks : null;
    if (!declared || declared.reading !== 'DISCOVERED') {
      var why;
      if (!declared || typeof declared.reading !== 'string') why = 'reading absent';
      else if (declared.reading === 'REFUSED') why = declared.code;
      else if (declared.reading === 'NOT_ATTEMPTED') why = declared.why;
      else why = declared.reading;
      return 'Declared plan could not be read — ' + why;
    }
    var done = countDeclared(repository, 'DONE');
    var open = countDeclared(repository, 'OPEN');
    var unreadable = countDeclared(repository, 'UNDETERMINED');
    if (unreadable > 0) {
      return done + ' done · ' + open + ' open · ' + unreadable + ' unreadable';
    }
    return done + ' / ' + declared.count + ' declared tasks done';
  }

  /* ── the active task is inferred, and says so ───────────────────────────── */

  /**
   * The tasks AO is plausibly working on, as candidates rather than a fact.
   *
   * The lease names no task, so this is derived: a loaded runtime record whose
   * `stateKind` is REGULAR. REGULAR is the precise reading. A BLOCKING task is
   * by definition one AO is NOT working on, and listing it here would page the
   * operator twice with contradictory framings — once under NEEDS YOU, once as
   * "likely active". A TERMINAL one is finished.
   *
   * Every qualifying task is returned. Choosing one would be a claim the data
   * cannot support.
   */
  function likelyActiveTasks(repository) {
    var tasks = items(repository ? repository.tasks : null);
    var picked = [];
    for (var index = 0; index < tasks.length; index += 1) {
      var runtime = tasks[index].runtime;
      if (runtime && runtime.reading === 'LOADED' && runtime.stateKind === 'REGULAR') {
        picked.push(tasks[index]);
      }
    }
    return picked;
  }

  /* ── ages, measured against the observation ─────────────────────────────── */

  /**
   * How long before the observation a record was written.
   *
   * Measured against `snapshot.observedAt`, never the device's own clock: a
   * phone with a skewed clock would otherwise print a negative age. The result
   * is clamped, so a record stamped ahead of the observation reads "just now"
   * rather than announcing a time-travelling machine.
   *
   * It says "recorded" on purpose, and every caller keeps that word.
   * `stateEnteredAt` is stamped when the STEP began — before a multi-minute
   * agent ran — and a checkpoint rewrites it with no state change at all, so
   * rendering it as "time in state" is exactly the invented precision this
   * slice refuses.
   */
  function recordedAge(isoInstant, observedAtIso) {
    var at = Date.parse(isoInstant);
    var observed = Date.parse(observedAtIso);
    if (isNaN(at) || isNaN(observed)) return 'recorded at an unreadable time';
    var elapsed = observed - at;
    if (elapsed < 1000) return 'recorded just now';
    var seconds = Math.floor(elapsed / 1000);
    if (seconds < 60) return 'recorded ' + seconds + ' s ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return 'recorded ' + minutes + ' min ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return 'recorded ' + hours + ' h ago';
    return 'recorded ' + Math.floor(hours / 24) + ' d ago';
  }

  /* ── reading notes: a failure always gets a sentence ────────────────────── */

  /**
   * One written sentence per reading-note code.
   *
   * The codes are a closed set in `read-model.ts`, and this table mirrors it.
   * A code with no row here falls back to a sentence that still reads as a
   * failure — the fallback is a gap in the wording, never a downgrade to calm.
   *
   * No sentence contains an ASCII apostrophe: these are emitted as authored
   * constants rather than through `escapeHtml`, and a `&#39;` in the middle of
   * a sentence would be a needless disfigurement.
   */
  var NOTE_SENTENCES = {
    REGISTRY_UNUSABLE: 'Repository registry could not be read',
    REPOSITORY_ROOT_UNRESOLVABLE: 'A declared repository path could not be resolved',
    REPOSITORY_ROOT_DUPLICATE: 'Two declared entries name one repository; the later one was dropped',
    PROFILE_UNUSABLE: 'A committed repository profile could not be read',
    TASK_DISCOVERY_REFUSED: 'Declared-task discovery refused, which is not an empty plan',
    RUNTIME_DIRECTORY_UNREADABLE: 'The runtime directory could not be listed',
    RUNTIME_SCAN_TRUNCATED: 'More runtime records than one observation reads, so this list is a prefix',
    TASK_STATE_UNREADABLE: 'A durable task record could not be read',
    DELIVERY_READER_THREW: 'A delivery position could not be read',
    VERIFICATION_READER_THREW: 'Verification evidence could not be read',
    LEASE_LOCATION_UNDETERMINED: 'The lease location could not be named, so no lease was read',
    LEASE_READER_THREW: 'The lease could not be read',
    ATTENTION_STORE_UNREADABLE: 'Attention store could not be read',
    ATTENTION_STORE_DISAGREES: 'A stored attention record names a task this reading does not find actionable'
  };

  var NOTE_FALLBACK = 'A reading could not be completed';

  function noteItems(notes) {
    var out = '';
    for (var index = 0; index < notes.length; index += 1) {
      var note = notes[index];
      out += '<li>' + (owns(NOTE_SENTENCES, note.code) ? NOTE_SENTENCES[note.code] : NOTE_FALLBACK);
      out += ' <span class="badge">' + escapeHtml(note.code) + '</span>';
      if (note.taskId) out += ' <span class="badge">' + escapeHtml(note.taskId) + '</span>';
      if (note.detail) out += ' ' + escapeHtml(note.detail);
      out += '</li>';
    }
    return out;
  }

  function notesSection(notes) {
    if (notes.length === 0) return '';
    return '<h2 class="note">READINGS THAT FAILED</h2><section class="card"><ul>' +
      noteItems(notes) + '</ul></section>';
  }

  /* ── the landing screen ─────────────────────────────────────────────────── */

  /**
   * The freshness banner, for every state that is not LIVE.
   *
   * Data already on screen is kept through STALE and OFFLINE and never
   * re-presented as current, so the banner is what carries the difference. Any
   * state this function does not recognise is named verbatim rather than
   * silently rendering nothing: an unrecognised freshness is not LIVE.
   */
  function freshnessBanner(freshness) {
    if (freshness === 'LIVE') return '';
    if (freshness === 'STALE') {
      return '<p class="note">STALE · showing data from the last successful fetch.</p>';
    }
    if (freshness === 'OFFLINE') {
      return '<p class="note">OFFLINE · showing data from the last successful fetch. ' +
        'Current AO state cannot be established.</p>';
    }
    return '<p class="note">' + escapeHtml(freshness) +
      ' · showing data from the last successful fetch.</p>';
  }

  function nameForKey(snapshot, repositoryKey) {
    var repositories = items(snapshot ? snapshot.repositories : null);
    for (var index = 0; index < repositories.length; index += 1) {
      if (repositories[index].repositoryKey === repositoryKey) {
        return repositoryName(repositories[index]);
      }
    }
    return 'Repository not in this snapshot';
  }

  /**
   * The operational badge row, which is a SEPARATE dimension from completion.
   *
   * Declaration and operational condition are different axes — a task can be
   * OPEN and CONFLICT at once — so these counts never join the completion line,
   * where they would imply a partition that does not exist.
   *
   * The badge says NEEDS OPERATOR, not NEEDS YOU: that phrase names the region
   * above, which appears only when the attention list is non-empty.
   */
  function conditionBadges(repository, snapshot) {
    var tasks = items(repository.tasks);
    var conflicts = 0;
    var index;
    for (index = 0; index < tasks.length; index += 1) {
      if (tasks[index].operational === 'CONFLICT') conflicts += 1;
    }
    var needs = items(snapshot ? snapshot.needsOperator : null);
    var needing = 0;
    for (index = 0; index < needs.length; index += 1) {
      if (needs[index].repositoryKey === repository.repositoryKey) needing += 1;
    }
    var out = '';
    if (conflicts > 0) out += '<span class="badge">' + conflicts + ' CONFLICT</span> ';
    if (needing > 0) out += '<span class="badge">' + needing + ' NEEDS OPERATOR</span>';
    return out;
  }

  function reviewLine(runtime) {
    if (typeof runtime.reviewBudget !== 'number' || runtime.reviewBudget <= 0) return '';
    return '<p class="note">Review ' + escapeHtml(runtime.reviewRound) + ' / ' +
      escapeHtml(runtime.reviewBudget) + '</p>';
  }

  function renderProject(repository, snapshot, observedAt) {
    var key = escapeHtml(repository.repositoryKey);
    var out = '<a class="project" href="#/repo/' + key + '" data-repo="' + key + '"><div>';
    out += '<p><strong>' + escapeHtml(repositoryName(repository)) + '</strong></p>';
    out += '<p class="note">' + escapeHtml(completionLine(repository)) + '</p>';
    var badges = conditionBadges(repository, snapshot);
    if (badges) out += '<p>' + badges + '</p>';
    out += '<p class="note">' + escapeHtml(leaseWording(repository.lease)) + '</p>';

    var active = likelyActiveTasks(repository);
    if (active.length === 0) {
      out += '<p class="note">No task in a work-loop state</p>';
    } else {
      out += '<p class="note">' +
        (active.length === 1 ? 'Likely active task' : 'Likely active tasks') + '</p>';
      for (var index = 0; index < active.length; index += 1) {
        var runtime = active[index].runtime;
        out += '<p>' + escapeHtml(active[index].taskId) + '</p>';
        out += '<p class="note">' + escapeHtml(runtime.state) + ' · ' +
          recordedAge(runtime.stateEnteredAt, observedAt) + '</p>';
        out += reviewLine(runtime);
      }
    }
    out += '</div><span class="badge">Open</span></a>';
    return out;
  }

  /**
   * What to say where the project list is empty.
   *
   * An empty list means "no repository" only when the registry itself was read.
   * Where that reading FAILED, the empty list is the absence of a reading, not
   * the reading of an absence — and "no projects" is then the most dangerous
   * sentence this page can print.
   */
  function emptyProjects(registry) {
    if (registry && registry.reading === 'REGISTERED') {
      return '<p class="note">The registry holds no repository.</p>';
    }
    if (registry && registry.reading === 'NOT_REGISTERED') {
      return '<p class="note">No repository is registered on this machine.</p>';
    }
    var code = registry && registry.code ? ' — ' + escapeHtml(registry.code) : '';
    return '<p class="note">Repositories could not be listed' + code + '</p>';
  }

  /**
   * The landing screen: attention, then projects.
   *
   * Snapshot-level notes come FIRST. A note whose `repositoryKey` is null
   * concerns the whole reading and has nowhere to sit in a per-project layout;
   * without a home, a failed registry read renders as "no projects" and a
   * failed attention-store read renders as "nothing needs you", which are the
   * two most dangerous outputs this UI can produce.
   *
   * NEEDS YOU appears only when the attention list is non-empty. A permanent
   * empty box teaches the reader to ignore that region, which is worse than no
   * region at all.
   */
  function renderLanding(snapshot, freshness) {
    var observedAt = snapshot ? snapshot.observedAt : null;
    var out = freshnessBanner(freshness);
    var index;

    var notes = items(snapshot ? snapshot.notes : null);
    var wholeReading = [];
    for (index = 0; index < notes.length; index += 1) {
      var key = notes[index].repositoryKey;
      if (key === null || key === undefined) wholeReading.push(notes[index]);
    }
    out += notesSection(wholeReading);

    var needs = items(snapshot ? snapshot.needsOperator : null);
    if (needs.length > 0) {
      out += '<h2 class="note">NEEDS YOU · ' + needs.length + '</h2>';
      for (index = 0; index < needs.length; index += 1) {
        var entry = needs[index];
        out += '<section class="card needs-you">';
        out += '<p><strong>' + escapeHtml(nameForKey(snapshot, entry.repositoryKey)) +
          ' · ' + escapeHtml(entry.taskId) + '</strong></p>';
        out += '<p><span class="badge">' + escapeHtml(entry.reason) + '</span></p>';
        out += '<p>' + escapeHtml(entry.text) + '</p>';
        out += '</section>';
      }
    }

    out += '<h2 class="note">PROJECTS</h2>';
    var repositories = items(snapshot ? snapshot.repositories : null);
    if (repositories.length === 0) {
      out += emptyProjects(snapshot ? snapshot.registry : null);
    } else {
      out += '<section class="card">';
      for (index = 0; index < repositories.length; index += 1) {
        out += renderProject(repositories[index], snapshot, observedAt);
      }
      out += '</section>';
    }
    return out;
  }

  /* ── the detail view ────────────────────────────────────────────────────── */

  function runtimeScanWording(scan) {
    if (!scan || typeof scan.reading !== 'string') return 'Runtime scan reading absent';
    if (scan.reading === 'READ') {
      return 'Runtime records read: ' + scan.stateFileCount +
        (scan.truncated ? ' · list truncated' : '');
    }
    if (scan.reading === 'DIRECTORY_ABSENT') return 'No runtime directory';
    if (scan.reading === 'DIRECTORY_UNREADABLE') return 'Runtime directory could not be listed';
    return 'Runtime scan reading: ' + scan.reading;
  }

  function renderRuntime(runtime, observedAt) {
    if (!runtime || typeof runtime.reading !== 'string') {
      return '<p class="note">Runtime reading absent.</p>';
    }
    if (runtime.reading === 'NONE') return '<p class="note">No runtime record.</p>';
    if (runtime.reading === 'UNREADABLE') {
      return '<p>Runtime record could not be read — <span class="badge">' +
        escapeHtml(runtime.code) + '</span></p>';
    }
    if (runtime.reading !== 'LOADED') {
      return '<p class="note">Runtime reading: ' + escapeHtml(runtime.reading) + '</p>';
    }
    var out = '<p>' + escapeHtml(runtime.state) + ' <span class="badge">' +
      escapeHtml(runtime.stateKind) + '</span></p>';
    // Never "time in this state": the field is stamped when the step began, and
    // a checkpoint rewrites it with no state change at all.
    out += '<p class="note">' + recordedAge(runtime.stateEnteredAt, observedAt) + '</p>';
    out += reviewLine(runtime);
    out += '<p class="note">Branch ' + escapeHtml(runtime.workBranch) + '</p>';
    out += '<p class="note">' + (runtime.recordedCurrentCommit
      ? 'Recorded commit ' + escapeHtml(runtime.recordedCurrentCommit)
      : 'No commit recorded') + '</p>';
    if (runtime.recordedPhaseAgent) {
      out += '<p class="note">Recorded phase agent ' + escapeHtml(runtime.recordedPhaseAgent) + '</p>';
    }
    if (runtime.blockedAgent) {
      out += '<p class="note">Blocked agent ' + escapeHtml(runtime.blockedAgent) + '</p>';
    }
    if (runtime.reportedResetAt) {
      out += '<p class="note">Reported reset at ' + escapeHtml(runtime.reportedResetAt) + '</p>';
    }
    return out;
  }

  /**
   * Verification evidence, still stated as evidence.
   *
   * Neither half is ever called "verified". A pass recorded FOR A COMMIT is
   * exactly that; whether the worktree still sits at that commit needs a fresh
   * read that no poll takes.
   */
  function renderVerification(verification, observedAt) {
    if (!verification || typeof verification.reading !== 'string') {
      return '<p class="note">Verification reading absent.</p>';
    }
    if (verification.reading === 'NONE') return '<p class="note">No verification evidence.</p>';
    if (verification.reading === 'UNREADABLE') {
      return '<p>Verification evidence could not be read — <span class="badge">' +
        escapeHtml(verification.code) + '</span></p>';
    }
    if (verification.reading !== 'RECORDED') {
      return '<p class="note">Verification reading: ' + escapeHtml(verification.reading) + '</p>';
    }
    var out = '';
    var attempt = verification.lastAttempt;
    if (attempt) {
      out += '<p class="note">Last attempt ' + escapeHtml(attempt.verdict) + ' · ' +
        recordedAge(attempt.attemptedAt, observedAt) +
        ' · commit ' + escapeHtml(attempt.forCommit);
      if (attempt.stoppedAtPhase) out += ' · stopped at ' + escapeHtml(attempt.stoppedAtPhase);
      if (attempt.exitCode !== null && attempt.exitCode !== undefined) {
        out += ' · exit ' + escapeHtml(attempt.exitCode);
      }
      out += '</p>';
    } else {
      out += '<p class="note">No verification attempt recorded.</p>';
    }
    if (verification.passRecordedForCommit) {
      out += '<p class="note">Pass recorded for commit ' +
        escapeHtml(verification.passRecordedForCommit) +
        (verification.passMeasuredAt
          ? ' · ' + recordedAge(verification.passMeasuredAt, observedAt)
          : '') + '</p>';
    } else {
      out += '<p class="note">No pass recorded for any commit.</p>';
    }
    return out;
  }

  function renderDelivery(delivery, observedAt) {
    if (!delivery || typeof delivery.reading !== 'string') {
      return '<p class="note">Delivery reading absent.</p>';
    }
    if (delivery.reading === 'NONE') return '<p class="note">No delivery recorded.</p>';
    if (delivery.reading === 'UNKNOWN') {
      return '<p class="note">Delivery position unknown — ' + escapeHtml(delivery.why) + '</p>';
    }
    if (delivery.reading === 'MERGE_RECORDED') {
      return '<p class="note">Merge recorded · PR ' + escapeHtml(delivery.pullRequestNumber) +
        ' · commit ' + escapeHtml(delivery.mergeCommit) +
        ' · base ' + escapeHtml(delivery.baseRef) + '</p>';
    }
    if (delivery.reading === 'DELIVERY_CONCLUDED') {
      return '<p class="note">Delivery concluded · PR ' + escapeHtml(delivery.pullRequestNumber) +
        ' · commit ' + escapeHtml(delivery.mergeCommit) +
        ' · ' + recordedAge(delivery.concludedAt, observedAt) + '</p>';
    }
    return '<p class="note">Delivery reading: ' + escapeHtml(delivery.reading) + '</p>';
  }

  function renderTask(task, observedAt) {
    var out = '<section class="card">';
    out += '<p><strong>' + escapeHtml(task.taskId) + '</strong> ' +
      '<span class="badge">' + escapeHtml(task.declaration) + '</span> ' +
      '<span class="badge">' + escapeHtml(task.operational) + '</span></p>';
    out += renderRuntime(task.runtime, observedAt);
    if (task.action) {
      out += '<p><span class="badge">' + escapeHtml(task.action.reason) + '</span></p>';
      out += '<p>' + escapeHtml(task.action.text) + '</p>';
    }
    out += renderVerification(task.verification, observedAt);
    out += renderDelivery(task.delivery, observedAt);
    out += '</section>';
    return out;
  }

  /**
   * One repository, in full.
   *
   * Everything the landing screen leaves out: the whole lease reading, the
   * runtime record, verification evidence, delivery, and THIS repository's
   * notes only — a snapshot-level note belongs to the landing screen, and
   * repeating it here would attribute a whole-reading failure to one project.
   *
   * It carries its own back control. An installed PWA runs in `standalone`
   * display and has no browser Back button, so a drill-down with no way out is
   * a dead end on the device this slice exists for. The `href` is the working
   * half; `data-back` is what the glue binds to.
   */
  function renderDetail(snapshot, repositoryKey) {
    var observedAt = snapshot ? snapshot.observedAt : null;
    var repositories = items(snapshot ? snapshot.repositories : null);
    var found = null;
    var index;
    for (index = 0; index < repositories.length; index += 1) {
      if (repositories[index].repositoryKey === repositoryKey) {
        found = repositories[index];
        break;
      }
    }

    var out = '<p><a class="badge" href="#/" data-back="1">Back to projects</a></p>';

    if (found === null) {
      return out + '<section class="card"><p>Repository <code>' +
        escapeHtml(repositoryKey) + '</code> is not in this snapshot.</p>' +
        '<p class="note">It may have left the registry, or this page may be showing an ' +
        'older observation.</p></section>';
    }

    out += '<section class="card">';
    out += '<p><strong>' + escapeHtml(repositoryName(found)) + '</strong></p>';
    out += '<p class="note">Key <code>' + escapeHtml(found.repositoryKey) + '</code></p>';
    if (found.profile && found.profile.reading === 'DECLARED') {
      out += '<p class="note">Default branch ' + escapeHtml(found.profile.defaultBranch) +
        ' · review rounds allowed ' + escapeHtml(found.profile.maxReviewRounds) + '</p>';
    }
    out += '<p>' + escapeHtml(completionLine(found)) + '</p>';
    out += '<p>' + escapeHtml(leaseWording(found.lease)) + '</p>';
    if (found.lease && found.lease.reading === 'HELD') {
      // A held lease whose record carries no acquisition time says so. The
      // other nullable runtime fields are omitted when absent because absence
      // is their NORMAL reading — no task is usually blocked — but a lease that
      // is held and cannot say since when is a degraded record, not a quiet one.
      out += '<p class="note">' + (found.lease.acquiredAt
        ? 'Lease taken · ' + recordedAge(found.lease.acquiredAt, observedAt)
        : 'Lease taken · no acquisition time recorded') + '</p>';
    }
    out += '<p class="note">' + escapeHtml(runtimeScanWording(found.runtimeScan)) + '</p>';
    out += '</section>';

    var tasks = items(found.tasks);
    out += '<h2 class="note">TASKS · ' + tasks.length + '</h2>';
    if (tasks.length === 0) {
      out += '<p class="note">No task records in this reading.</p>';
    }
    for (index = 0; index < tasks.length; index += 1) {
      out += renderTask(tasks[index], observedAt);
    }

    var notes = items(snapshot ? snapshot.notes : null);
    var mine = [];
    for (index = 0; index < notes.length; index += 1) {
      if (notes[index].repositoryKey === found.repositoryKey) mine.push(notes[index]);
    }
    out += notesSection(mine);
    return out;
  }

  /* ── routing ────────────────────────────────────────────────────────────── */

  var DETAIL_PREFIX = '#/repo/';

  /**
   * The whole route table: one drill-down pattern, and the landing screen.
   *
   * Drill-down is in-page state with hash navigation, so the server's route
   * surface stays the closed manifest set while history back still works. The
   * hash is read on LOAD as well as on `hashchange`, so a relaunch at a deep
   * link renders the detail view.
   *
   * The key is taken verbatim and never decoded. A repository key is a hex
   * digest, so there is nothing to decode; and `decodeURIComponent` throws on a
   * malformed escape, which would turn a mistyped bookmark into a blank page.
   * An unmatched key renders as "not in this snapshot", which is the honest
   * answer to a hash naming no repository.
   */
  function renderRoute(hash, snapshot, freshness) {
    var text = typeof hash === 'string' ? hash : '';
    if (text.indexOf(DETAIL_PREFIX) === 0) {
      return renderDetail(snapshot, text.slice(DETAIL_PREFIX.length));
    }
    return renderLanding(snapshot, freshness);
  }

  global.AO = {
    classifyFreshness: classifyFreshness,
    escapeHtml: escapeHtml,
    leaseWording: leaseWording,
    repositoryName: repositoryName,
    completionLine: completionLine,
    likelyActiveTasks: likelyActiveTasks,
    recordedAge: recordedAge,
    renderLanding: renderLanding,
    renderDetail: renderDetail,
    renderRoute: renderRoute
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
