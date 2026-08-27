# AgentOrchestrator — Operator Guide

Verbindliche Betriebsanleitung für AgentOrchestrator (`agent-loop`).

`README.md` ist der Produkt- und Entwurfsbericht: was gebaut wurde, warum es so
gebaut wurde, und was jede Zusicherung wert ist. Dieses Dokument ist das andere:
**wie man das Ding benutzt.** Wo beide dieselbe Tatsache berühren, ist das
Verhalten des ausgelieferten Codes autoritativ; jede hier zitierte
Programmausgabe stammt aus dem Emitter, nicht aus einer Paraphrase.

Es schließt außerdem zwei Lücken, die der Closing Audit ausdrücklich als
Dokumentationslücken benannt hat: **A4** (wie man einen Run stoppt, stand bisher
nur in einer Fehlermeldung, die man erst sieht, wenn es zu spät ist) und **A5**
(die Beurteilung eines überlebenden Agent-Prozesses lag beim Operator, ohne dass
ihm dafür etwas an die Hand gegeben wurde). Siehe [§17](#17-einen-run-stoppen-und-die-stale-lease).

---

## 1. Aktueller Produktstatus

AgentOrchestrator ist freigegeben für:

```text
ATTENDED / SUPERVISED REAL-WORLD USE
```

Nicht freigegeben ist:

```text
UNATTENDED / 24×7 AUTONOMOUS USE
```

Der Closing Audit (gegen `main` bei `877ffdc`, 2026-08-16) hat **keinen
`ATTENDED_RELEASE_BLOCKER`** gefunden. Er hat vier `UNATTENDED_BLOCKER`
gefunden — U1–U4 — und die haben alle dieselbe Form: *das Ende eines Runs, und
der Zustand der Maschine danach, hängen davon ab, dass ein Mensch da ist.* Genau
das behauptet `--attended`. Deshalb blockiert keiner von ihnen den beaufsichtigten
Betrieb, und jeder von ihnen ist für unbeaufsichtigten Betrieb tödlich.

### Seit V3-08: ein sehr schmaler unbeaufsichtigter Pfad — und was er nicht ist

`agent-loop run --automatic-resume-only --task <id>` setzt **einen einzelnen,
bereits gestarteten Task** ohne anwesenden Menschen fort — und nur dann, wenn die
kanonische Resume-Entscheidung frisch `AUTOMATIC_ALLOWED` liefert. Mit
`--wait-for-reset --max-wait-ms <n>` darf er dafür **einmal** auf ein gemeldetes
Quota-Reset warten, ohne dabei die Execution Lease zu halten.

Das ist **keine** Freigabe für unbeaufsichtigten Betrieb, und U1–U4 bleiben offen.
Der Modus kann nicht:

* einen Task starten (kein Worktree, kein Branch, kein State);
* laufende Arbeit aufnehmen, die er **nicht selbst resumed hat** — ein
  reconciled `IMPLEMENTING` oder `VERIFYING` wird abgelehnt;
* eine Stale Lease entfernen;
* einen Task auswählen — `--task` ist Pflicht;
* ein Review-Budget auffüllen;
* mehr als einmal pro Aufruf warten.

Was er nach einem erlaubten Resume **sehr wohl** tut: den Task ganz normal
weiterfahren — Writer, Verify, Review, Remediation — bis `--max-steps`. Die
Einschränkung liegt am *Eingang*, nicht auf dem, was danach passiert. (Ein
Review hat hier ursprünglich "normale laufende Arbeit fortsetzen" gefunden,
was schlicht falsch war.)

**Und heute kann er ohnehin nicht auslösen.** Keine der beiden Agent-CLIs meldet
eine Quota-Reset-Zeit, also ist `reportedResetAt` immer `null`, und
`evaluateAutomaticResume` verweigert mit `RESET_TIME_MISSING`. Der Slice liefert
die fehlende *Autorität*, nicht den fehlenden *Nachweis*. Praktisch heißt das:
Ein Run, der auf `BLOCKED_USAGE_LIMIT` stoppt, wird auch mit diesen Flags nicht
von selbst weiterlaufen — du startest ihn nach dem Reset weiterhin selbst.

AgentOrchestrator kann heute:

```text
Task-Block bestimmen
        ↓
Dependency-Graph einfrieren
        ↓
Execution Lease übernehmen
        ↓
Claude implementiert
        ↓
Projekt-Verify
        ↓
unabhängiger Review
        ↓
Remediation
        ↓
Task SETTLED
        ↓
abhängigen Nachfolger starten
        ↓
Block COMPLETE
```

Bei abhängigen Tasks gilt:

```text
A.resultCommit
      ↓
B.basePinnedCommit
```

**A wird also nicht zuerst gemergt.** Der Nachfolger baut direkt auf dem Ergebnis
des Vorgängers auf.

Gleichzeitig gilt:

```text
B.scopeAuthorityCommit
=
blockBaseCommit
```

Ein Vorgänger darf seinem Nachfolger also **Code**, aber keine zusätzliche
Berechtigung geben. Das ist keine Konvention, sondern durable: der Block-Runner
schreibt `scopeAuthorityCommit: blockBaseCommit` in den ersten Datensatz jedes
Mitglieds (`src/block/block-runner.ts`), und die Scope-Prüfung liest ihn aus dem
persistierten State, nicht aus dem laufenden Aufruf.

---

## 2. Was AgentOrchestrator nicht automatisch erledigt

Ein erfolgreicher Block bedeutet **nicht**:

* GitHub-PRs gemergt;
* Issues geschlossen;
* Worktrees entfernt;
* Branches entfernt;
* Repository aufgeräumt.

Ein Task endet typischerweise in:

```text
READY_FOR_PR
```

und wird im Block als:

```text
SETTLED
```

registriert. `READY_FOR_PR` ist ein **terminaler** Zustand — der Orchestrator
übergibt fertige Arbeit an einen Menschen und hört dort auf. Die Integration
danach ist ein beaufsichtigter Arbeitsschritt und kein Rückstand im Produkt.

Zwei Folgen davon, die im Alltag zählen:

* **Ein abgebrochener Run wird nicht über eine neue Invocation resumed.** Eine
  gestartete Run-ID gilt als verbraucht — `startBlockRun` weist sie zurück
  (siehe [§13](#13-die-run-id)).
* **Jeder abgeschlossene Task hinterlässt genau einen Worktree, einen Branch und
  eine verbrauchte Task-ID.** `release` nimmt keinen davon zurück, weil alle
  durable State haben. Das ist der Audit-Punkt A2: sichtbar, prüfbar, von Hand
  aufräumbar — und nichts davon passiert automatisch.

---

## 3. AgentOrchestrator starten

Normaler Checkout:

```powershell
cd D:\AgentOrchestrator
```

Vor Benutzung:

```powershell
git status --short -uall
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
```

Soll:

```text
branch = main
status = clean
HEAD == origin/main
```

CLI:

```powershell
node .\dist\cli\index.js --help
node .\dist\cli\index.js block --help
```

`dist/` ist das, was läuft. Nach einem `git pull` ist es **nicht** automatisch
aktuell — wenn sich `src/` geändert hat, gilt:

```powershell
npm run build
```

und für die vollständige kanonische Prüfung `npm run verify`.

Aktueller Block-Vertrag:

```text
--repository <path>  absolutes Zielrepository, nie aus dem cwd abgeleitet
--block <id>         Block-ID
--tasks <ids...>     Mitglieder in Ausführungsreihenfolge
--run <id>           vom Operator vergebene Run-ID
--attended           tatsächliche Ausführung
--max-steps <n>      Step-Budget pro Driver-Aufruf, Default 8
```

`--max-steps` ist kein Budget für den Task und keines für den Run, sondern für
**einen** Driver-Aufruf. Wird es erreicht, hat der Driver nach durable Fortschritt
angehalten, und der Runner treibt denselben Task unter derselben Lease erneut.
Ein ungültiger Wert wird mit `MAX_STEPS_INVALID` abgewiesen, bevor irgendetwas
passiert.

Weitere Befehle, alle read-only außer `release`:

```text
doctor          Umgebung diagnostizieren (CLI-Fähigkeiten, Auth, Schreibzugriff)
run             was ein Einzeltask-Run täte; mit --attended: ein Task
block           was ein Block-Run täte; mit --attended: der Block
lease status    wer gerade Writer dieses Repositories ist
release         einen Workspace zurücknehmen, den ein abgestürzter Start ließ
```

---

## 4. Unterstützte Umgebung

Verifiziert und erzwungen ist:

```text
Windows
Node.js 22 oder 24
lokales NTFS
```

Node prüfen:

```powershell
node --version
```

Das ist eine **Whitelist, kein Minimum**: Node 23 oder 25 werden von der Runtime-
Gate der CLI abgewiesen (Exit 6), nicht nur nicht empfohlen. Netzlaufwerke und
UNC-Pfade werden von der Lease abgewiesen, nicht als Randfall behandelt.

Andere Plattformen sind nicht als produktiv verifiziert zu betrachten.

---

## 5. ntfy-Benachrichtigungen

Die Konfiguration liegt **außerhalb der Repositories**:

```text
%USERPROFILE%\.agent-orchestrator\notify.yaml
```

Bei dir also:

```text
C:\Users\Max\.agent-orchestrator\notify.yaml
```

Beispiel:

```yaml
endpoint: https://ntfy.sh/
topic: dein-langer-zufälliger-topic
```

Optional ist zusätzlich `token:` für einen geschützten Endpoint. Andere
Schlüssel sind nicht erlaubt — die Datei wird gegen einen geschlossenen Vertrag
geparst, und eine Verletzung schaltet die Benachrichtigung ab, statt den Run zu
stoppen.

Prüfen:

```powershell
Test-Path "$env:USERPROFILE\.agent-orchestrator\notify.yaml"
```

Soll: `True`.

**Opt-in ist die Abwesenheit der Datei.** Ohne sie öffnet dieser Build keinen
Socket — das ist gegen das ausgelieferte Artefakt gemessen, nicht behauptet.

Beim Start erscheint eine von drei Zeilen:

```text
Notification : ARMED - an ending that needs an operator will be reported
Notification : OFF (not configured) - no notification will be sent and no network is used
Notification : OFF (configuration unusable: <CODE>) - the run still proceeds
```

Sie wird **vor** dem Run gedruckt, damit man eine kaputte Konfiguration erfährt,
während man noch zusieht — und nicht durch eine Nachricht, die nie ankommt.

Ein erfolgreicher Block endet absichtlich mit:

```text
Notification : SILENT - this ending does not need an operator
```

`COMPLETE` erzeugt also keinen Push.

**Kein Push bedeutet nicht Erfolg.** Das ist U2 und A1 zusammen: es gibt einen
gebundenen Versuch, zehn Sekunden, keinen Retry und keinen zweiten Kanal; ein
verlorener Push druckt `NOT DELIVERED (<code>)` in eine Konsole, die niemand
liest. Und da `COMPLETE` ohnehin still ist, trägt ein stilles Telefon keinerlei
Information. Autoritativ sind das Terminal und der durable State.

Was **nie** ins Repository gehört — nicht in `repo-profile.yaml`, nicht in
Task-Dateien, nicht in README, nicht in Git, nicht in den Sourcecode:

```text
topic
token
endpoint mit eingebettetem Secret
```

Der Topic ist die Adresshälfte des Credentials und wird deshalb auch von der CLI
nie gedruckt.

---

## 6. Ein Projekt für AgentOrchestrator vorbereiten

Ein Projekt braucht eine AO-Projektion:

```text
.agent-orchestrator/
├── repo-profile.yaml
├── tasks/
│   ├── TASK-A.md
│   └── TASK-B.md
└── runtime/
```

`runtime/` ist durable Maschinen-State: `<taskId>.json` je Task und
`blocks/<runId>.json` je Block-Run.

**Nicht manuell editieren.**

### 6.1 `runtime/` muss von Git ignoriert sein — sonst startet nichts

Das ist die häufigste Startblockade und keine Stilfrage.

Der Task-State wird **innerhalb** des Zielrepositories geschrieben. Die
Workspace-Vorbereitung weist einen Source-Checkout mit uncommitted **oder
untracked** Änderungen als `SOURCE_WORKTREE_DIRTY` zurück. Ist `runtime/` nicht
ignoriert, hinterlässt Task 1 eine untracked Datei, und Task 2 scheitert daran —
der erste Task gelingt, jeder weitere verweigert, verursacht durch eine Datei,
die der Orchestrator selbst geschrieben hat.

Deshalb wird das geprüft, **vor dem ersten durable Write**, und es fällt zu:

```text
RUNTIME_NOT_IGNORED
```

Gefragt wird Git selbst (`git check-ignore`), nicht ein nachgebauter
`.gitignore`-Parser. In die `.gitignore` des Zielprojekts gehört also:

```gitignore
.agent-orchestrator/runtime/
```

Prüfen lässt sich das vorab genau so, wie AO es prüft:

```powershell
cd D:\Pfad\Zum\Projekt
git check-ignore -v .agent-orchestrator/runtime/TASK-A.json
```

Eine Ausgabe bedeutet ignoriert; keine Ausgabe (Exit 1) bedeutet, dass der erste
Run verweigern wird.

### 6.2 `repo-profile.yaml`

Vollständig. `additionalProperties` ist aus, und alle Felder sind Pflicht — mit
einer Ausnahme: `delivery` ist optional.

```yaml
schemaVersion: 1
repository:
  id: mein-projekt                  # [a-z0-9._-], das ist die Identität nach außen
  defaultBranch: main               # muss lokal existieren, kein Fallback auf main/master
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks
context:
  canonicalSources:
    - AGENTS.md                     # benannt, nicht inline kopiert
    - VERIFY.md
capabilities:
  codegraph: REQUIRED               # oder OPTIONAL
verification:
  phases:
    - phase: BUILD
      command: [npm, run, build]
    - phase: TEST
      command: [npm, test]
    - phase: VERIFY                 # eine VERIFY-Phase ist Pflicht
      command: [npm, run, verify]
scope:
  allowedPaths:
    - src/domain/foo
  protectedPaths: []
completion:
  maxReviewRounds: 3
remote:
  required: true
delivery:                           # optional; fehlt der Block, gibt es kein Ziel
  remote: origin                    # das Remote, dessen PUSH-URL das Ziel benennt
```

Drei Dinge, die man einmal wissen muss:

* **Die Verify-Policy kann ein Writer nicht umschreiben.** Sie stammt aus einer
  Lesung des Source-Checkouts zu Beginn der Invocation und wird als Wert
  mitgeführt — nicht aus dem Worktree, den der schreibende Agent editieren kann.
* **`defaultBranch` wird nicht geraten.** Nennt das Profil einen Branch, der
  lokal nicht existiert, ist das `DEFAULT_BRANCH_NOT_FOUND` und nicht ein
  stillschweigender Rückfall auf `main`.
* **`delivery` benennt ein Ziel und erlaubt nichts.** AO liest daraus
  `host/owner/name` und zeigt es im Read-only-Plan an. Dieser Build pusht nicht,
  öffnet keinen Pull Request, liest keine CI und merged nicht; `READY_FOR_PR`
  bleibt terminal. Fehlt der Block, fragt AO Git gar nicht danach. Das Remote
  wird genannt, nicht geraten: `origin` ist eine Konvention von `git clone`,
  keine Tatsache über einen Checkout — und gelesen wird die **Push**-URL, weil
  ein Pull Request dort entsteht, wohin der Branch gepusht wurde.

---

## 7. Task-Dateien

Das Frontmatter-Schema ist geschlossen (`schemas/task-definition.schema.json`),
alle sieben Felder sind Pflicht:

```yaml
---
id: PROJECT-AREA-001A
title: First delivery
status: OPEN                # OPEN | DONE
kind: NORMAL                # NORMAL | REMEDIATION
priority: NORMAL            # HIGH | NORMAL | LOW
currentFocus: false
dependsOn: []
---
```

Abhängiger Nachfolger:

```yaml
---
id: PROJECT-AREA-001B
title: Second delivery
status: OPEN
kind: NORMAL
priority: NORMAL
currentFocus: false
dependsOn:
  - PROJECT-AREA-001A
---
```

Der Body sollte nur den Kontext enthalten, den der Coding-Agent wirklich braucht:

1. präzises Ziel bzw. Defekt;
2. erlaubter Scope;
3. ausdrücklich ausgeschlossener Scope;
4. Akzeptanzkriterien;
5. Verify-Anforderungen;
6. bekannte Risiken;
7. Verweise auf relevante kanonische Repo-Dokumente.

**Keine komplette Roadmap, README oder Historie in jeden Task kopieren.**

---

## 8. Dependencies sind echte Ausführungsautorität

Für `A → B` zeigt der Preview zunächst:

```text
A eligible
B not eligible — waiting on A
```

Im attended Run:

```text
A → Implementierung → Verify → Review → SETTLED → A.resultCommit → B startet darauf
```

AgentOrchestrator schreibt dafür **nicht** zwischendurch die Roadmap auf `DONE`.
Roadmap-`DONE` ist keine Evidenz über Git. Die Dependency wird run-lokal durch
durable Settlement **plus** Git-Chain erfüllt, und die Chain-Tauglichkeit des
Vorgänger-Commits wird gegen Git bewiesen, in dem Moment, in dem sie benutzt wird.

Ein Mitglied, dessen Vorgänger **nicht** relativ zueinander geordnet sind (eine
Raute), hat keinen einzelnen Commit, auf dem es bauen könnte. Der ganze Block
wird dann abgewiesen, bevor irgendetwas startet — nicht dieses eine Mitglied
übersprungen. Die zwei Wege, einen solchen Commit zu erfinden, wären mergen und
jemandes Arbeit fallenlassen; dieser Build tut keines von beidem.

---

## 9. Scope richtig konfigurieren

`repo-profile.yaml` bildet die harte Repository-Grenze.

Wenn A `src/domain/foo` braucht und B `src/ui`, muss der eingefrorene Block-Scope
bereits beide erlauben:

```yaml
scope:
  allowedPaths:
    - src/domain/foo
    - src/ui
```

Nicht unnötig `src` oder `src/domain` freigeben.

Der Scope gehört zum **Block-Base**. Bei einem dependent successor gilt:

```text
Execution Base = A.resultCommit          (was er sieht)
Scope Authority = blockBaseCommit        (was er darf)
```

Geprüft wird gegen den **tatsächlichen Repository-Effekt** des Tasks: das ganze
Delta ab `basePinnedCommit`, untracked Dateien eingeschlossen — vor *und* nach
jedem schreibenden Agent. Nicht `git status`, und keine Selbstauskunft des
Agenten.

---

## 10. Repository vor einem Run prüfen

Vor jedem echten Run:

```powershell
cd D:\Pfad\Zum\Projekt

git fetch origin
git status --short -uall
git branch --show-current
git rev-parse HEAD
git rev-parse origin/<default-branch>
git worktree list
```

Das Source-Repository soll:

```text
auf dem echten Default-Branch stehen
clean sein
aktuell sein
```

Keine zweite Writer-Session parallel starten. Und keinen Worktree von Hand
anlegen — AO übernimmt seine Task-Worktrees selbst.

---

## 11. Immer zuerst Preview

Der Block-Befehl ist ohne `--attended` read-only.

```powershell
cd D:\AgentOrchestrator

node .\dist\cli\index.js block `
  --repository "D:\Pfad\Zum\Projekt" `
  --block PROJECT-AREA-001 `
  --tasks PROJECT-AREA-001A PROJECT-AREA-001B `
  --run project-area-001-20260816-01
```

Ein abhängiger Preview sieht so aus:

```text
Repository   : mein-projekt  (D:\Pfad\Zum\Projekt)
Block        : PROJECT-AREA-001   run project-area-001-20260816-01
Mode         : report only - --attended was not given

Members
  PROJECT-AREA-001A eligible      depends on no member
  PROJECT-AREA-001B not eligible  depends on PROJECT-AREA-001A

Independent  : no
  A member depends on another member, so a task that fails locally ends the run rather
  than continuing past work its successor was to be built on. The dependent members
  are chained: see below.

Chain shape  : every member has a base
  PROJECT-AREA-001B would be built on the result of PROJECT-AREA-001A
```

Drei verschiedene Fragen, die man nicht verwechseln darf, und die der Preview
deshalb getrennt beantwortet:

* **Eligibility** ist die Antwort des Repository-Selektors, live gefragt.
* **Independent** und **Chain shape** sind Antworten der eingefrorenen Relation.
* Ein Mitglied ohne Block-interne Dependency kann trotzdem auf einen Task
  **außerhalb** des Blocks warten. Ein Block, dessen einziger Weg zur
  Eligibility außerhalb liegt, endet `NO_ELIGIBLE_TASK`.

Der Preview:

```text
startet keinen Agent
schreibt keinen TaskState
schreibt keinen Block-Ledger
nimmt keinen Execution Lease
erstellt keinen Task-Worktree
```

Er behält auch nichts: der attended Run nimmt seine eigene Lesung unter seiner
eigenen Lease. Der Preview beschreibt, wogegen ein Run gestartet *würde* — er
friert nichts ein, das etwas autorisiert.

---

## 12. Danach attended starten

Exakt denselben Block und dieselbe Run-ID verwenden, nur `--attended` ergänzen:

```powershell
node .\dist\cli\index.js block `
  --repository "D:\Pfad\Zum\Projekt" `
  --block PROJECT-AREA-001 `
  --tasks PROJECT-AREA-001A PROJECT-AREA-001B `
  --run project-area-001-20260816-01 `
  --attended
```

`--max-steps` standardmäßig nicht setzen; der ausgelieferte Default ist `8`.

Ausführung braucht drei voneinander unabhängige Dinge, und keines impliziert ein
anderes:

```text
--attended      der Operator erklärt, für diese Invocation anwesend zu sein
Auth-Preflight  frisch, muss bestehen; --attended behauptet nichts über Credentials
Execution Lease dieses Repositories, die höchstens eine Invocation zum Writer macht
```

---

## 13. Die Run-ID

Die Run-ID muss der Operator vergeben. Sie wird nie generiert: eine erfundene
Run-ID wäre ein Run, den ein Operator nicht benennen kann.

Sinnvoll:

```text
zera-resolver-052-20260816-01
zera-auth-block-20260816-01
```

> Sobald die attended Invocation gestartet wurde, ist die Run-ID verbraucht.

Denselben Befehl nach einem Stop erneut auszuführen liefert:

```text
Outcome      : RUN_GATE_REFUSED   detail RUN_ID_ALREADY_USED
```

mit Exit 4. Das ist U4: nichts setzt einen unterbrochenen Run fort, und keine
Task-ID wird je wieder freigegeben. Für einen neuen Versuch braucht es eine neue
Run-ID — und vorher eine Entscheidung darüber, was mit dem unterbrochenen Task
geschehen soll.

---

## 14. Während des Runs

**Nicht:**

* Source-Checkout editieren;
* Task-Worktrees manuell editieren;
* Commits auf AO-Taskbranches durchführen;
* Vorgänger-Task mitten in der Chain mergen;
* `.agent-orchestrator/runtime/` editieren;
* Lease-Dateien entfernen;
* zweiten attended AO-Run starten;
* parallel Claude Code als Writer in demselben Projekt verwenden.

Wenn etwas stoppt:

> Erst Evidenz sichern, dann handeln.

---

## 15. Erfolgreiches Ende

```text
Repository   : mein-projekt  (D:\Pfad\Zum\Projekt)
Block        : PROJECT-AREA-001   run project-area-001-20260816-01
Outcome      : BLOCK_RUN_ENDED   reason COMPLETE
  Every frozen task is settled on the strength of its own record. The block is done.

Tasks
  PROJECT-AREA-001A SETTLED    TASK_COMPLETED
  PROJECT-AREA-001B SETTLED    TASK_COMPLETED

Steps        : 6

Notification : SILENT - this ending does not need an operator
```

Das bedeutet:

```text
Block logisch abgeschlossen
Tasks durable settled
```

Es bedeutet **nicht**:

```text
merged
released
Worktrees gelöscht
Branches gelöscht
Issues geschlossen
```

---

## 16. Wenn der Run stoppt

Nicht jede Störung bedeutet „noch einmal probieren“. Erst unterscheiden:

```text
TASK konnte nicht fertig werden
```

von:

```text
RUN kann nicht mehr sicher weiterarbeiten
```

Genau diese Unterscheidung trägt die Ausgabe. **Endet der Run mit
`BLOCK_RUN_ENDED`, trägt der Ledger das Ende** und die Task-Tabelle ist der
Datensatz. Bei den anderen vier Outcomes trägt der Ledger das Ende *nicht*: er
steht auf seinem letzten durable Stand und hält jedes Task-Ergebnis, das bis
dahin aufgezeichnet wurde. „Es wurde nichts geschrieben“ ist in diesen Fällen
falsch und wird deshalb auch nicht behauptet.

### Exit-Codes

| Code | Bedeutung |
| --- | --- |
| `0` | in Ordnung |
| `1` | unerwartet — ein Defekt dieses Tools |
| `2` | Eingabe unbrauchbar |
| `3` | ein Operator muss hinsehen |
| `4` | verweigert — nichts ist durable kaputt, ein späterer Versuch kann anders ausgehen |
| `6` | Runtime nicht unterstützt (Plattform/Node-Major) |

Ein Block-Run produziert nie `5` (*call again*): sein Leben ist das Leben seiner
Invocation, es gibt also keinen Zustand, in dem ein erneuter Aufruf etwas
fortsetzen würde.

### Endungen mit Ledger-Eintrag (`BLOCK_RUN_ENDED`, `reason …`)

| Reason | Exit | Was es heißt |
| --- | --- | --- |
| `COMPLETE` | 0 | jedes eingefrorene Mitglied ist aus eigener Kraft settled |
| `TASK_BLOCKED` | 3 | ein Task hängt an etwas, das ein Mensch lösen muss |
| `TASK_ABANDONED` | 3 | ein Task wurde aufgegeben — terminal, nichts baut darauf auf |
| `NO_ELIGIBLE_TASK` | 2 | kein eingefrorenes Mitglied war lauffähig |
| `OPERATOR_STOPPED` | 4 | ein Operator hat absichtlich gestoppt |
| `LEDGER_DIVERGED` | 3 | Ledger und Task-Records widersprechen sich |
| `STATE_UNUSABLE` | 3 | ein Task-Record ist kaputt oder gehört woanders hin |
| `DEFINITION_DRIFTED` | 3 | der eingefrorene Plan passt nicht mehr zur Definition |
| `ACTIVE_TASK_UNRESOLVED` | 3 | ein Task war in Arbeit, sein Ausgang ließ sich nicht sicher feststellen |

Divergenz wird **nie durch Schreiben aufgelöst**. Der Run stoppt und sagt es.

### Endungen ohne Ledger-Eintrag

| Outcome | Exit | Was es heißt |
| --- | --- | --- |
| `LEASE_AUTHORITY_UNCERTAIN` | 4 | dieser Run ist womöglich nicht mehr der Writer — weiterzuschreiben wäre genau die Handlung, für die ihm die Autorität fehlt |
| `RUN_GATE_REFUSED` | 4 | ein Repository-, Auth- oder Runtime-Gate hat abgelehnt; der Task, den es nicht startete, ist weiterhin `PLANNED` |
| `DURABLE_WRITE_FAILED` | 3 | ein durable Write wurde verweigert; Platte oder Berechtigung müssen repariert werden |
| `RECONCILIATION_UNRESOLVED` | 3 | Task-State hat sich unter gehaltener Lease bewegt; nichts wurde repariert und nichts wiederholt |

### Bei einem Stop

1. Terminalausgabe sichern.
2. ntfy-Nachricht sichern, falls vorhanden.
3. Ledger nicht editieren.
4. TaskState nicht editieren.
5. Worktrees nicht löschen.
6. Lease nicht reflexartig löschen.
7. Ursache read-only untersuchen — `git log`, `git status`, `agent-loop lease
   status`, der Ledger unter `.agent-orchestrator/runtime/blocks/<runId>.json`.
8. Erst danach über einen neuen Run entscheiden.

---

## 17. Einen Run stoppen, und die Stale Lease

*(Dieser Abschnitt schließt die Audit-Punkte A4 und A5.)*

**Es gibt keinen sauberen Weg, einen laufenden Block-Run abzubrechen.** Das ist
gemessen, nicht vermutet: `block-runner.ts` installiert kein Signal-Handling, ein
Konsolen-Interrupt beendet den Prozess also ohne Abwicklung, und das `finally`,
das die Lease zurückgibt, läuft nie. Gemessen sah das so aus:

```text
while holder alive : HELD / owner pid 22092
holder ending      : {"code":null,"signal":"SIGINT"}
lease file exists  : true
after interrupt    : HELD / liveness NOT_FOUND
recovery verdict   : STALE_OWNER_GONE
next acquire       : STALE_LEASE_RECOVERY_UNSAFE
```

Das ist U1. Für attended Betrieb ist es laut und fail-closed und damit richtig —
für unbeaufsichtigten Betrieb macht ein einziger Absturz das Repository dauerhaft
unbenutzbar.

### Was du siehst

Die nächste Invocation wird abgewiesen mit:

```text
A lease is present and this build cannot prove it is safe to take: its owner process
  is not observably running, or the record cannot be read. It is deliberately not
  taken over - a dead owner does not prove that no agent process survived it. Run
  `agent-loop lease status` to see what is there. This build has no command that
  removes it: an attended break was shipped twice and withdrawn twice, because for a
  record left by a crash there is no fact an operator can be shown that still names
  the same object once the removal runs. Clearing it is a decision outside this tool.
```

Davon zu unterscheiden ist die normale Meldung, dass jemand anders gerade
arbeitet:

```text
Another orchestrator invocation holds the execution lease for this repository, and a
  process with the recorded id exists. Nothing was started. Wait for it. …
```

Diese hier wartet man aus. Man beendet **nicht** den genannten Prozess: Prozess-IDs
werden wiederverwendet, der laufende Prozess muss nicht der Eigentümer sein, und
dieser Build kann nicht sagen, welcher es ist.

### Was du tust

```powershell
node .\dist\cli\index.js lease status --repository "D:\Pfad\Zum\Projekt"
```

Die Lease-Datei liegt im Git-Common-Dir des Repositories:

```text
<repo>\.git\agent-orchestrator-execution-lease.json
```

AO entfernt eine zweifelhafte Lease **absichtlich nicht** und bietet dafür auch
keinen Befehl an. Sie zu löschen ist eine Entscheidung außerhalb dieses Tools —
und sie ist deine, nicht die des Tools.

Bevor du sie triffst, ist die eigentliche Frage nicht „lebt der Eigentümer noch“,
sondern (A5):

> **Läuft noch ein Agent-Prozess, den dieser Run gestartet hat?**

Ein toter Eigentümer beweist nicht, dass kein Agent ihn überlebt hat, und ein
überlebender Writer plus ein neuer Run sind zwei Writer im selben Repository.
Prüfen, bevor du die Lease löschst:

```powershell
# Agent-Prozesse, die der Run gestartet haben könnte
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'node|claude|codex' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine |
  Format-List

# Was AO im Repository stehen ließ
git -C "D:\Pfad\Zum\Projekt" worktree list
git -C "D:\Pfad\Zum\Projekt" status --short -uall
```

Erst wenn kein solcher Prozess mehr läuft und der Worktree-Zustand verstanden
ist, ist das Löschen der Lease-Datei eine begründete Handlung. Baue dafür **keine**
automatische Recovery:

```powershell
Remove-Item ...execution-lease...   # nicht skripten
```

Der Grund ist kein Aberglaube: ein Gate auf Bytes plus ein Unlink auf einen Pfad
ist ein ABA-Autoritätsdefekt — zwischen Prüfung und Löschung kann der Pfad ein
anderes Objekt benennen. Genau daran ist der attended Break zweimal gescheitert
und wurde zweimal zurückgezogen.

---

## 18. Nach COMPLETE

Erfolgreiche Task-Worktrees und Branches bleiben bestehen. Das ist Teil des
beaufsichtigten Handoffs — und es akkumuliert: ein Worktree, ein Branch und eine
verbrauchte Task-ID pro Task (A2).

Für einen wichtigen abhängigen Block lohnt die Nachprüfung. Sie liest zwei
verschiedene Dateien, und man sollte wissen welche:

**Ledger** — `.agent-orchestrator/runtime/blocks/<runId>.json`:

```text
stopReason = COMPLETE
tasks[A].disposition = SETTLED
tasks[B].disposition = SETTLED
tasks[A].resultCommit = <sha>
tasks[B].baseCommit  == tasks[A].resultCommit
```

**Task-State** — `.agent-orchestrator/runtime/<taskId>.json`:

```text
A.basePinnedCommit      == blockBaseCommit
B.basePinnedCommit      == A.resultCommit
A.scopeAuthorityCommit  == blockBaseCommit
B.scopeAuthorityCommit  == blockBaseCommit
```

Zusätzlich sollte Git zeigen:

```text
blockBase → A.resultCommit → B.resultCommit
```

Praktisch:

```powershell
cd D:\Pfad\Zum\Projekt
git log --oneline --graph <blockBase>..<B.resultCommit>
git merge-base --is-ancestor <A.resultCommit> <B.resultCommit>; $LASTEXITCODE   # 0
```

Beides zu lesen ist der Punkt: der Ledger sagt, was der Run aufgezeichnet hat,
und der Task-State sagt, unter welcher Autorität gearbeitet wurde. Wo beide
auseinanderlaufen, glaubt AO den Task-Records — und stoppt, statt zu reparieren.

---

## 19. Delivery beobachten (V4 Slice 2) — read-only

Nach `READY_FOR_PR` übergibt AO an einen Menschen. Seit V4 Slice 2 kann AO dir
dabei **zwei Fragen beantworten**, ohne irgendetwas zu tun:

```powershell
agent-loop delivery --repository D:\Pfad\Zum\Projekt --task <taskId>
```

Ohne `--observe` passiert **kein Netzwerkzugriff**. Der Befehl zeigt nur, worüber
eine Beobachtung überhaupt ginge: das Delivery-Ziel aus `repo-profile.yaml` und
den exakten Commit aus dem Task-State.

Mit `--observe` fragt AO `github.com` — lesend:

```powershell
agent-loop delivery --repository D:\Pfad\Zum\Projekt --task <taskId> --observe
```

```text
Delivery     : origin -> github.com/Owner/Repo  (identity only; nothing is delivered)
State        : READY_FOR_PR
Subject      : 10583ee91a5747d0049f563ffaac64b0cf643aeb
Pull request : MATCHED  (#55)
Checks       : SUCCESS  (2 check run(s), 0 commit status(es): 2 succeeded, 0 pending, 0 failed, 0 neutral/skipped)

Conclusion   : OBSERVED
```

### Was die Antworten bedeuten — und was nicht

- **`Subject`** ist der exakte Commit. Jede Zeile darunter gilt für **genau
  diesen** Commit. Nicht für den Branch, nicht für „den neuesten Stand".
- **`MATCHED (#N)`** heißt: genau ein **offener** Pull Request hat **genau diesen
  Commit** als aktuellen Head. Ein PR, dessen Head inzwischen weitergewandert
  ist, ergibt `NO_MATCHING_PULL_REQUEST` — das ist eine Antwort, kein Fehler.
- **`SUCCESS`** heißt: alle Check Runs **und** alle Legacy-Commit-Statuses zu
  diesem Commit sind fertig und keiner blockiert. `NO_CHECKS` ist **kein**
  Erfolg, sondern eine eigene Antwort.
- **Alles andere** — `NOT_AUTHENTICATED`, `REQUEST_FAILED`, `UNSUPPORTED_HOST`,
  `RESULTS_TRUNCATED`, … — heißt: **nichts** ist festgestellt. Nicht „wahrscheinlich
  ok".

**Der Befehl entscheidet nichts.** Er sagt dir nicht, ob gemerged werden darf.
`PR vorhanden` ist nicht `mergebar`, `mergebar` ist nicht `CI grün`, und `CI grün`
ist nicht „Review erfüllt". Diese Entscheidung bleibt bei dir.

### Voraussetzungen

- `repo-profile.yaml` deklariert ein Delivery-Ziel (siehe §6.2, `delivery.remote`);
- der Task hat einen gepinnten Commit (`currentCommit`), also mindestens einmal
  committet;
- **GitHub CLI installiert und eingeloggt**: `gh auth login`. AO liest deinen
  Token **nie** — `gh` hält ihn selbst. Ohne Login: `NOT_AUTHENTICATED`.
- **Nur `github.com`.** Ein anderes Ziel ergibt `UNSUPPORTED_HOST`, und es wird
  nichts kontaktiert.
- **Kein Proxy-Support.** Proxy-Variablen werden bewusst nicht weitergereicht.

### Exit-Codes

```text
0   Beide Fragen beantwortet (auch bei „kein PR" oder „Checks rot"),
    oder ohne --observe geplant.
2   Kein Subjekt feststellbar (kein Delivery-Ziel, kein State, kein Commit).
4   Mindestens eine Frage blieb offen — nichts ist festgestellt.
```

### Was der Befehl nicht tut

Kein Push, kein PR anlegen, kein Kommentar, kein Review, kein Merge. Kein
Task-State wird geschrieben, keine Lease genommen, kein Agent gestartet.
`READY_FOR_PR` bleibt terminal.

### Was trotzdem ins Netz geht

AO fragt **nur** nach dem einen Commit, der unter `Subject` steht. Die GitHub
CLI selbst telefoniert aber zusätzlich nach Hause: Telemetrie mit einer
Geräte-ID, und einmal pro 24 Stunden eine Update-Prüfung. AO unterdrückt das
**nicht** — das würde bedeuten, `gh` Umgebungswerte unterzuschieben, die der
Operator nie gesetzt hat. Wer das abstellen will, stellt es in der `gh`-eigenen
Konfiguration ab. Notiert als `L-V4-02-6`.

---

## 19a. Nachlesen, wozu AO sich selbst berechtigt hat (V4 Slice 15) — read-only

Wenn AO **unbeaufsichtigt** einen Branch auf dem Delivery-Remote anlegen darf
(`delivery --drive --publish-head --automatic-publish-head-only`, siehe §1),
schreibt es **vorher** einen unveränderlichen Datensatz — und seit V4 Slice 16
**danach** einen zweiten. Beide liegen außerhalb jedes Repositories, in deinem
eigenen Benutzerprofil:

```text
%USERPROFILE%\.agent-orchestrator\head-publication-authorisations\
    <UTC-Zeitpunkt>-<uuid>\
        authorisation.json   <- vor dem Kontakt zum Delivery-Remote geschrieben
        outcome.json         <- nach der Veröffentlichungsverarbeitung geschrieben
```

Die zweite Datei kam mit V4 Slice 16 dazu. Sie wird **einmal** angelegt und nie
überschrieben, und `authorisation.json` wird dabei nicht angefasst.

Seit V4 Slice 15 kannst du das lesen:

```powershell
agent-loop publication authorisations
```

**Kein `--repository`, kein Netzwerk.** Der Befehl liest genau
dieses eine Verzeichnis. Er startet kein Git, keine GitHub CLI und keinen Agenten,
nimmt keine Lease, legt nichts an und ändert nichts — auch dann nicht, wenn das
Verzeichnis gar nicht existiert.

Eigene Optionen gibt es seit V4 Slice 17 vier, und sie benennen **einen Branch**:
`--forge-host`, `--forge-owner`, `--forge-name` und `--ref`. Ohne sie zeigt der
Befehl alles, wie bisher. Sie verlangen kein Repository, keinen Checkout und
keinen Netzzugang — siehe unten.

```text
Store        : C:\Users\Max\.agent-orchestrator\head-publication-authorisations
Listing      : READ
Entries      : 1 (1 read, 0 not read)
  Every entry in the store is a record this build read, and nothing beside one of them is
  a document it could not.

Entry        : 20260827T120000000Z-a64c0f2f-1982-4958-972c-459ac0d678ef
  Reading      : HISTORICAL_AUTHORISATION
  Authorised at: 2026-08-27T12:00:00.000Z
  Act          : HEAD_PUBLICATION, invocation mode AUTOMATIC
  Task         : V4-14
  Checkout     : D:\AgentOrchestrator
  Delivery     : origin -> github.com/M4XD4B0ZZ/AgentOrchestrator
  Ref          : refs/heads/ao/task/V4-14
  Commit       : 10583ee91a5747d0049f563ffaac64b0cf643aeb
  Declaration  : AUTOMATIC_ALLOWED, sha256 f59d285e0c233651c7610df32edf58d0d932a3ada9c50f984ff128ce5c7c5a5b
  Outcome      : HISTORICAL_OUTCOME
  Recorded at  : 2026-08-27T12:00:02.140Z
  Publication  : DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER
  Command      : RAN_TO_EXIT_ZERO
```

### Was die vier neuen Zeilen heißen (V4 Slice 16)

`Publication` sagt, **was dieser Lauf aufgerufen und was seine letzte Lesung des
Refs ergeben hat**. Das erste Wort ist die einzige sichere Angabe auf der Zeile:
`DISPATCHED` heißt, dass der eine Push-Befehl an die Prozessgrenze übergeben
wurde, `NOT_DISPATCHED` heißt, dass das nicht geschah. Der Rest benennt, was eine
Lesung zu **einem Zeitpunkt** über den Ref ergeben hat.

Beide Beschriftungen gehören zu **diesem** Bericht. Der Delivery-Bericht hat eine
eigene `Publication`-Zeile mit einem anderen Vokabular (der Veröffentlichungs-
Bewertung: `ALREADY_PUBLISHED`, `PUBLISHED`, `OUTCOME_UNCERTAIN`, …) und eine
`Outcome`-Zeile mit dem Code des Stores. Gleiche Wörter, zwei Berichte, zwei
Fragen.

`Command` sagt, **was aus diesem einen Befehl wurde**. `NOT_CALLED` heißt: er
wurde der Prozessgrenze nie übergeben, es gibt also gar keine Meldung. Das ist
der eigene Kontrollfluss dieses Builds und nicht die Antwort von irgendwem, und
es sagt dasselbe wie die `NOT_DISPATCHED`-Hälfte der Zeile darüber. Die anderen
vier sind das, was die
Prozessgrenze über einen tatsächlich übergebenen Befehl gemeldet hat — eine
Aussage über einen Prozess, nicht über ein Netzwerk. Von diesen vieren ist
`NO_PROCESS` das einzige, das ein Negativ festlegt: es gab nichts zu starten,
also existierte kein Prozess dafür. Eine abgelehnte Prozesserzeugung, ein
Zeitlimit und eine verlorene Prozessgrenze fallen alle auf
`ENDING_NOT_ESTABLISHED` — keines davon belegt, dass nie ein Prozess lief.

**Nichts davon sagt, dass AO den Commit auf den Delivery-Remote gebracht hat.**
Das ist gemessen falsch, nicht bloß unbewiesen: ein Push eines Commits, den der
Ref schon hält, endet mit 0 und meldet den Remote als aktuell — ohne dass das
Lease überhaupt geprüft wird. Ein Lauf, der nichts geändert hat, erreicht also
die stärkste Lesung dieser Zeile.

### Wenn dort `Outcome      : OUTCOME_ABSENT` steht

> **Kein Outcome heißt: es wurde kein dauerhaftes Ergebnis festgehalten. Es heißt
> nicht, dass nichts passiert ist.**

Zwischen einem Ref-Update auf github.com und einer Datei auf deiner Platte gibt es
keine Transaktion. Ein Prozess, der dazwischen stirbt, hinterlässt genau diese
Form — und jeder Lauf jedes Builds vor Slice 16 ebenfalls. Es wird nichts
nachgetragen und nichts geraten, und ein Eintrag ohne Outcome zieht die Bewertung
der Liste **nicht** herunter.

### Wenn AO das Ergebnis nicht schreiben konnte

```text
Drive        : PUBLICATION_OUTCOME_NOT_DURABLE
```

Exit-Code **3** als Untergrenze: jemand muss hinsehen. Der Store ersetzt die
Zahl mit seinem eigenen Code, einen nach dem anderen — drei seiner zwölf Codes
sind interne Fehler und ergeben stattdessen **1**. Bewusst nicht
`EFFECT_ATTEMPTED` und bewusst nicht Exit 5 ("nochmal aufrufen"), denn ein
erneuter Aufruf liest den *Remote* und kann den vergangenen Moment nicht
zurückholen. Es wird nichts ein zweites Mal gesendet, um an einen Datensatz zu
kommen, und es wird nichts rückgängig gemacht — es gibt nichts, was AO
rückgängig machen könnte.

**Diese Meldung sagt nicht, dass etwas versucht wurde.** Das Outcome wird auf
*jedem* Pfad geschrieben, auf dem auch die Autorisierung geschrieben wurde — auch
auf den vieren, die nichts senden. Was der Lauf aufgerufen und zuletzt gelesen
hat, steht auf der `Publication`-Zeile daneben, und was aus dem Datensatz wurde,
auf der `Outcome`-Zeile darunter.

### Was ein Eintrag heißt — und was nicht

- Ein Datensatz sagt: **zu diesem Zeitpunkt** hat ein Lauf aus der Deklaration mit
  genau diesen Bytes festgestellt, dass automatisches Publizieren für dieses
  Repository erlaubt war, und hat Task, Checkout, Remote, Ref und Commit als
  Gegenstand der **einen** Veröffentlichung bestimmt, die er dann versuchen
  durfte.
- Er sagt **nicht**, dass etwas versucht wurde. Er wird geschrieben, **bevor** AO
  den Remote überhaupt anspricht. Ein Lauf, der den Ref schon auf diesem Commit
  vorfindet, sendet nichts — und hinterlässt denselben Datensatz.
- Er sagt **nicht**, dass der Branch existiert, und **nicht**, dass AO ihn
  angelegt hat.
- Er sagt **nicht**, dass die Erlaubnis heute noch gilt. Der Befehl liest
  `delivery-automation.yaml` gar nicht.
- `Declaration` ist der SHA-256 der **exakten Bytes** der Deklaration zu jenem
  Zeitpunkt. Ein Kommentar, ein Zeilenende oder CRLF ändern ihn — und alle
  ergeben dieselbe Erlaubnis. Der Digest ist keine Aussage über Bedeutung.

### Reihenfolge

Sortiert nach Eintragsnamen: erst die Einträge, die AO als Event-Verzeichnis
liest, dann alles andere. Der Name eines Event-Verzeichnisses trägt den
Zeitpunkt, den die Uhr des schreibenden Laufs gemeldet hat — ein Name ist aber
nur ein Name, und wer im Store schreiben kann, wählt ihn selbst. Die Zeit **im**
Datensatz wird gegen nichts geprüft.

### Kaputte Einträge werden gezeigt, nie weggelassen

Was AO nicht als Datensatz lesen kann, steht trotzdem in der Liste, mit einer
eigenen Zeile `Reading` und einem Satz, was es ist. Die Zählzeile trennt beides:
`Entries : 5 (3 read, 2 not read)`.

```text
HISTORICAL_AUTHORISATION   gelesen, Digest passt zum Verzeichnisnamen
RECORD_ABSENT              Event-Verzeichnis ohne Datensatz: Absturz beim Schreiben,
                           eine Verweigerung danach, der Datensatz wurde
                           geloescht, oder jemand hat hier einfach ein
                           Verzeichnis angelegt. AO unterscheidet das nicht.
RECORD_EMPTY               Datei da, 0 Bytes — das schreibt AO nie
RECORD_UNREADABLE          Link, keine normale Datei, Lesen misslang, oder der
                           Name war gar nicht abfragbar
RECORD_MALFORMED           kein Datensatz dieses Builds (auch: zu groß)
RECORD_UNSUPPORTED_VERSION neuere Vertragsversion — verweigert, nichts wird gezeigt
RECORD_NOT_THIS_EVENT      Digest passt nicht zum Verzeichnis: kopiert oder verändert
UNRECOGNISED_ENTRY         gar kein Event-Verzeichnis: Link, Datei, fremder Name -
                           oder AO konnte den Eintrag gar nicht bestimmen
```

### Exit-Codes

```text
0   Eine Liste wurde erstellt — auch wenn kaputte Einträge darin stehen.
    Auch: kein Store vorhanden, oder Store leer.
3   Der Store selbst war nicht lesbar: er ist kein Verzeichnis, ODER ein
    Verzeichnis auf dem Weg dorthin ist keines, ODER ein Link liegt im Pfad,
    ODER das Profil war nicht ermittelbar. Das ist derselbe Store, in den die
    nächste unbeaufsichtigte Veröffentlichung schreiben müsste.
```

Ein kaputter Eintrag ist **kein** Exit-Code-3-Fall: nichts auf einem
Autoritätspfad nimmt je einen gespeicherten Datensatz als Erlaubnis, und AO
löscht hier nie etwas — ein
Nicht-Null-Code wäre dauerhaft und mit diesem Werkzeug nicht wegzubekommen. Der
Befund steht im Bericht.

### Was der Befehl dir nicht beweisen kann

**Jeder Prozess, der als dein OS-Benutzer läuft, kann einen Datensatz schreiben,
der genauso aussieht wie die echten — und jeden davon spurlos löschen.** Der
Binding-Digest ist Integritätsstruktur, keine Signatur: es gibt in diesem Build
keinerlei Schlüsselmaterial. Er erkennt einen aus einem anderen Event kopierten
Datensatz, ein nachträglich geändertes Feld und einen Datensatz aus einem Build
mit anderem Vertrag. Mehr nicht.

Deshalb heißt **leerer Store**: hier ist jetzt nichts. Er heißt **nicht**, dass
nie etwas erlaubt wurde — eine beaufsichtigte Veröffentlichung schreibt hier
überhaupt nichts, ein anderer OS-Benutzer hat einen eigenen Store, und Gelöschtes
hinterlässt keine Lücke.

### Weiterleiten in `head` oder einen Pager ist in Ordnung

Der Bericht ist bewusst unbegrenzt lang. Wenn du ihn in `head`, `more` oder einen
Pager schickst und den Leser schließt, ist das ein **normales Ende**: AO bricht
nicht ab und meldet keinen Fehler.

### Der Store wächst unbegrenzt

Ein Verzeichnis pro erlaubter unbeaufsichtigter Veröffentlichung, dauerhaft.
**AO** löscht dort nie etwas, und dieser Befehl auch nicht — ohne Angabe zeigt er
**alle** Einträge, ohne Limit und ohne Seiten. Ein Mensch oder ein anderer Prozess
unter demselben OS-Benutzer kann sehr wohl löschen; siehe oben. Eine
Aufbewahrungsregel ist eine eigene Entscheidung und bewusst noch nicht getroffen
(`L-V4-14-1`, `L-V4-15-1`).

### Nach genau einem Branch fragen (V4 Slice 17)

Seit V4 Slice 17 kannst du den Bericht auf **einen** Branch einschränken:

```powershell
agent-loop publication authorisations `
  --forge-host github.com `
  --forge-owner M4XD4B0ZZ `
  --forge-name AgentOrchestrator `
  --ref refs/heads/ao/task/V4-17
```

**Alle vier Angaben oder keine.** Keine heißt: die ganze Liste wie bisher. Ein
bis drei werden abgelehnt, mit Exit-Code **2** und ohne dass irgendetwas gelesen
wird.

**Ein Branch sind vier Werte, nicht einer.** `refs/heads/main` in Repository A ist
nicht derselbe Branch wie derselbe Ref in Repository B. Deshalb werden Host,
Owner, Repository-Name und Ref verglichen — **zeichenweise**. Nichts wird
klein-/großgeschrieben angeglichen, nichts abgeschnitten, nichts ergänzt, und es
wird nie ein Teil eines Wertes verglichen. Ein anders geschriebener Owner ist ein
anderer Owner; genau so entscheidet auch die Erlaubnis (`L-V4-13-3`).

**Achtung — nicht jeder Schreibfehler wird verglichen.** Die vier Angaben müssen
den Regeln entsprechen, unter denen AO selbst eine Identität aufschreibt. Was
diesen Regeln nicht entspricht, wird **abgelehnt** (Exit-Code 2) und gar nicht
erst verglichen. Am ehesten trifft dich das beim Host: der muss **klein**
geschrieben sein. `--forge-host GitHub.com` ergibt

```text
Query        : FORGE_HOST_UNUSABLE
```

und nicht "0 Treffer". Umgekehrt heißt das: einen Datensatz, den etwas anderes
mit einem Wert außerhalb dieser Regeln geschrieben hat, kannst du mit keiner
Abfrage benennen — er wird als "naming another branch" gezählt, und die Liste
ohne Abfrage zeigt ihn vollständig (`L-V4-17-2`).

**Der Commit gehört nicht dazu.** Zwei Veröffentlichungen desselben Branches auf
zwei Commits sind zwei Einträge einer Historie, und beide werden gezeigt. Ebenso
zwei Einträge auf demselben Commit, zwei aus verschiedenen Klonen und zwei über
Remotes mit verschiedenen lokalen Namen. Es wird nichts zusammengefasst, nichts
entdoppelt und nichts auf "den neuesten" reduziert.

**Der Ref muss vollständig sein.** `refs/heads/mein-branch`, nie `mein-branch`.
Ein kurzer Name würde bedeuten, dass AO `refs/heads/` errät — und `refs/heads/`
ist selbst etwas, das in einem Branch-Namen vorkommen darf, ein Rateergebnis
stünde also für zwei verschiedene gespeicherte Werte.

**Was AO nicht vollständig lesen konnte, wird trotzdem gezeigt.** Ein Eintrag ohne
lesbaren Datensatz trägt weder Host noch Owner noch Name noch Ref — er kann also
weder zutreffen noch ausgeschlossen werden. Und ein Eintrag, dessen Datensatz AO
zwar lesen konnte, neben dem aber ein Dokument liegt, das es nicht lesen konnte,
ist genau der Eintrag, den die Zeile `Listing` bereits gegen den Store zählt —
ihn wegzulassen würde diese Zeile zu einer Lüge machen. Beide stehen bei **jeder**
Abfrage in der Liste. Weggelassen wird nur eines: ein Eintrag, den AO vollständig
gelesen hat und dessen Datensatz einen anderen Branch nennt. Die Zählzeile sagt,
wie viele es jeweils sind:

```text
Query        : github.com/M4XD4B0ZZ/AgentOrchestrator refs/heads/ao/task/V4-17
Entries      : 6 (5 read, 1 not read)
Matching     : 3 named by this query, 2 naming another branch, 1 not established
```

`Entries` und `Listing` sagen weiterhin etwas über den **ganzen** Store: ein
kaputter Eintrag außerhalb deiner Abfrage zieht die Bewertung weiterhin herunter,
denn die Aufzählung erfährt von der Abfrage gar nichts.

**Kein Treffer heißt nicht "war nie erlaubt".** Der stärkste wahre Satz lautet:
in diesem Store ist jetzt kein von AO lesbarer Datensatz, der diesen Branch
nennt. Löschen hinterlässt keine Lücke, eine beaufsichtigte Veröffentlichung
schreibt hier gar nichts, ein anderer OS-Benutzer hat einen eigenen Store, und
dieser Befehl fragt keinen Forge. Wenn im Store zusätzlich Einträge liegen, die
AO nicht lesen konnte, steht ein anderer Satz da, der genau das sagt.

**Das ist ein Filter, kein Index.** Es wird weiterhin **jeder** Eintrag geöffnet
und bewertet, um die Frage zu beantworten. `L-V4-14-3` ist damit ein zweites Mal
verkleinert und immer noch offen.

---

## 20. Jetzt speziell: Zera / HealthApp

AgentOrchestrator soll die **zentrale Orchestrierung für Zera/HealthApp**
übernehmen. Die HealthApp-eigene Queue ist Übergangsinfrastruktur:

```text
AgentOrchestrator = zentraler Orchestrator
HealthApp Queue   = Legacy / Transition
```

Beide dürfen **nicht gleichzeitig als konkurrierende Writer** laufen.

---

## 21. Zera Repository

Der reale Checkout ist:

```text
D:\Workspaces_VSCode\HealthApp
```

Zuletzt war der kanonische Ziel-/Default-Branch:

```text
chore/clean-arch-structure
```

Aber für jeden echten Run gilt:

> Nicht aus Erinnerung übernehmen — vor dem Run gegen das Repository prüfen.

```powershell
cd D:\Workspaces_VSCode\HealthApp

git fetch origin
git status --short -uall
git branch --show-current
git rev-parse HEAD
git remote show origin
git worktree list
```

Der Wert, den `repo-profile.yaml` als `defaultBranch` nennt, muss der sein, den
dieses Repository wirklich benutzt — er wird gegen den lokalen Ref geprüft und
nicht geraten.

---

## 22. Zera: CodeGraph ist Pflicht — auf zwei Ebenen

Für Zera gilt verbindlich: **jeder Claude-Code-Task beginnt mit einem
CodeGraph-Preflight.** Das zerfällt in zwei Teile, und nur einer davon lässt sich
konfigurieren.

**Ebene 1 — Profil, erzwungen.** Im `repo-profile.yaml`:

```yaml
capabilities:
  codegraph: REQUIRED
```

Der Repository-Resolver prüft das, bevor irgendetwas anderes passiert, und fällt
fail-closed nach `REQUIRED_CAPABILITY_UNAVAILABLE`. Was er dabei beweist, ist
genau eine Sache: dass am Repository-Root ein echtes Verzeichnis `.codegraph`
liegt. Deshalb heißt der positive Status `INDEX_PRESENT` und nicht `AVAILABLE`.

**Was Ebene 1 nicht beweist:** dass der Index gültige Inhalte hat, dass er zum
Working Tree aktuell ist, dass ein MCP-Server konfiguriert ist, oder dass
`codegraph_explore` aus der Agent-Session erreichbar ist. Der Orchestrator ist
nicht die Agent-Session und kann das Tool nicht aufrufen — jede Behauptung
darüber wäre ein erfundenes PASS.

**Ebene 2 — Task-Body, nicht automatisierbar.** Deshalb muss der Task-Kontext den
Rest weiterhin selbst anweisen:

```text
1. CodeGraph Status/Connectivity prüfen.
2. Eine minimale Repository-Abfrage durchführen, z. B. codegraph_explore.
3. Wenn CodeGraph nicht funktioniert: STOP.
4. Nicht ohne CodeGraph weiterimplementieren.
```

Das gehört in jede Zera-Task-Datei, bis der Build Tool-Erreichbarkeit selbst
beweisen kann. Dann bekommt sie einen *eigenen* zweiten Status — sie definiert
`INDEX_PRESENT` nicht um.

---

## 23. Zera: Kontext klein halten

Für Zera soll AO nicht ständig komplette `ROADMAP.md`, `VERIFY.md`, `AGENTS.md`,
Historie und alte Handoffs in den Agent-Kontext laden.

Stattdessen pro Task nur:

```text
Task-ID
Ziel/Defekt
Scope
Nicht-Scope
Akzeptanzkriterien
Risiken
relevante kanonische Abschnitte
Verify-/Review-Vertrag
```

Claude liest den nötigen Kontext anschließend **selektiv selbst im Repository**.
Das ist auch die Bauweise des Produkts: `context.canonicalSources` **benennt**
Dateien, es kopiert sie nicht in den Brief. Das spart Kosten und verhindert
veraltete Kontextpakete.

---

## 24. Zera: Subagents

Bei Claude-Code-Tasks muss ausdrücklich stehen, ob Subagents sinnvoll sind.

Wenn ja:

```text
read-only analysis
independent review
bounded research
```

aber:

```text
keine Edits
keine Git-Mutation
keine Commits
```

Ein Writer bleibt autoritativ.

---

## 25. Zera: Verify + Review

Der gewünschte normale AO-Ablauf:

```text
Claude implementiert
        ↓
Zera Verify
        ↓
Codex unabhängiger Review
        ↓
Findings
        ↓
Claude Remediation
        ↓
Verify
        ↓
erneute Bewertung
        ↓
SETTLED
```

Nicht:

```text
Claude sagt "fertig" → automatisch akzeptieren
```

Und kein PASS gilt als belastbar, nur weil der Code plausibel aussieht. Die
Review-Seite soll versuchen, die Lösung zu **widerlegen**. Die Zahl der Runden
bindet `completion.maxReviewRounds` im Profil.

---

## 26. Erstmalige Zera-Adoption

**Noch nicht blind einen AO-Run starten.** Einmalig nötig:

```text
1. aktuellen HealthApp Default-Branch feststellen
2. aktuellen Current Focus aus dem echten Repo lesen
3. feststellen, welche bestehende HealthApp-Automation noch Writer sein könnte
4. nächsten echten Task bzw. kleinen Block auswählen
5. AO-Task-Projektion erstellen
6. repo-profile für den Block minimal festlegen
7. .agent-orchestrator/runtime/ in .gitignore aufnehmen und mit
   git check-ignore verifizieren
8. CodeGraph-Vertrag in die Zera-Tasks aufnehmen
9. Preview
10. attended Run
```

Danach ist das kein Setup mehr, sondern Routine.

---

## 27. Beispiel für den späteren Zera-Aufruf

Wenn der nächste echte Block `ZERA-X-A → ZERA-X-B` lautet, zuerst:

```powershell
cd D:\AgentOrchestrator

node .\dist\cli\index.js block `
  --repository "D:\Workspaces_VSCode\HealthApp" `
  --block ZERA-X `
  --tasks ZERA-X-A ZERA-X-B `
  --run zera-x-20260816-01
```

Erst bei korrektem Preview:

```powershell
node .\dist\cli\index.js block `
  --repository "D:\Workspaces_VSCode\HealthApp" `
  --block ZERA-X `
  --tasks ZERA-X-A ZERA-X-B `
  --run zera-x-20260816-01 `
  --attended
```

---

## 28. Kurzcheck vor jedem produktiven Run

```text
AgentOrchestrator
[ ] main
[ ] clean
[ ] aktuell
[ ] dist gebaut, falls src sich geändert hat

Zielprojekt
[ ] tatsächlicher Default-Branch
[ ] clean (git status --short -uall leer)
[ ] aktuell
[ ] kein konkurrierender Writer
[ ] .agent-orchestrator/runtime/ nachweislich ignoriert
[ ] keine fremde Lease (agent-loop lease status)

Task
[ ] echte aktuelle Aufgabe
[ ] Dependencies korrekt
[ ] Akzeptanzkriterien klar
[ ] Verify klar
[ ] Scope minimal
[ ] Zera: CodeGraph-Pflicht enthalten

AO
[ ] Task-Projektionen aktuell
[ ] repo-profile korrekt
[ ] Preview korrekt
[ ] neue Run-ID
[ ] ntfy ARMED

Dann:
[ ] --attended
```
