# AO bedienen — die Kurzfassung

Wie du AgentOrchestrator auf deine eigenen Projekte loslässt. In der Reihenfolge,
in der du es wirklich machst.

Das hier ist die Kurzfassung. Alle Feinheiten — ntfy, MCP-Capabilities, Delivery,
Quota-Resets, Blöcke mit Abhängigkeiten — stehen in
[`OPERATOR-GUIDE.md`](OPERATOR-GUIDE.md).

---

## In einem Satz

Du schreibst eine Aufgabe in eine Datei. AO gibt sie an Claude Code weiter, lässt
Codex draufschauen, führt deine Tests aus und schreibt mit, was passiert ist. Du
sagst vorher, was es anfassen darf.

AO tut nie etwas, wofür du nicht ausdrücklich das passende Flag gesetzt hast.
Ohne `--attended` ist fast jeder Befehl nur eine Vorschau: kein Agent startet,
nichts wird geschrieben, keine Sperre wird genommen.

**Voraussetzung:** Windows, Node 22 oder 24, lokales NTFS. Das ist eine
Whitelist. Node 23 oder 25 werden abgewiesen (Exit 6), nicht bloß „nicht
empfohlen".

---

## Teil A — einmal pro Projekt einrichten

### A1. Ordner anlegen

In deinem Projekt, nicht in AO:

```text
DeinProjekt\
└── .agent-orchestrator\
    ├── repo-profile.yaml     ← die Regeln
    ├── tasks\                ← deine Aufgaben
    │   └── PROJ-001.md
    └── runtime\              ← AO schreibt hier. Nie von Hand anfassen.
```

### A2. `runtime/` in die `.gitignore`

Das ist die häufigste Startblockade. AO schreibt seinen Zustand ins Projekt. Ist
der Ordner nicht ignoriert, ist dein Repo nach dem ersten Task „dirty", und der
zweite Task wird verweigert — verursacht von einer Datei, die AO selbst
geschrieben hat.

```gitignore
.agent-orchestrator/runtime/
```

So prüfst du es genau so, wie AO es prüft. Ausgabe = gut, keine Ausgabe = AO wird
verweigern:

```powershell
cd D:\Pfad\Zum\Projekt
git check-ignore -v .agent-orchestrator/runtime/PROJ-001.json
```

Der Fehlercode dafür heißt `RUNTIME_NOT_IGNORED` und bedeutet genau das hier,
nichts anderes.

### A3. `repo-profile.yaml` schreiben

Alle Felder sind Pflicht, außer `delivery`. Kopieren und anpassen:

```yaml
schemaVersion: 1
repository:
  id: mein-projekt          # nur a-z 0-9 . _ -
  defaultBranch: main       # muss lokal existieren, wird nicht geraten
taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks
context:
  canonicalSources:         # Dateien, die der Agent lesen soll
    - AGENTS.md
capabilities:
  codegraph: OPTIONAL       # oder REQUIRED
verification:
  phases:
    - phase: BUILD
      command: [npm, run, build]
    - phase: TEST
      command: [npm, test]
    - phase: VERIFY         # diese Phase ist Pflicht
      command: [npm, run, verify]
scope:
  allowedPaths:             # hier darf der Agent schreiben
    - src/
  protectedPaths: []        # hier nie
completion:
  maxReviewRounds: 3
remote:
  required: true
delivery:                   # optional
  remote: origin
```

Zwei Dinge, die einmal wehtun:

- **`defaultBranch` wird nicht geraten.** Steht dort ein Branch, den es lokal
  nicht gibt, ist das `DEFAULT_BRANCH_NOT_FOUND` und kein stiller Rückfall auf
  `main`.
- **Die Verify-Befehle kann der schreibende Agent nicht umschreiben.** AO liest
  sie am Anfang aus deinem sauberen Checkout, nicht aus dem Worktree, den der
  Agent editiert.

### A4. Umgebung einmal durchmessen

```powershell
cd D:\AgentOrchestrator
node .\dist\cli\index.js doctor
```

Liest nur, ändert nichts. Prüft, ob `claude` und `codex` da sind und ob du
eingeloggt bist.

---

## Teil B — eine Aufgabe schreiben

Eine Datei pro Aufgabe, in `.agent-orchestrator/tasks/`. Die sieben Kopf-Felder
sind alle Pflicht.

```markdown
---
id: PROJ-001
title: Login-Fehler beheben
status: OPEN          # OPEN oder DONE
kind: NORMAL          # NORMAL oder REMEDIATION
priority: NORMAL      # HIGH, NORMAL, LOW
currentFocus: false
dependsOn: []         # IDs aus DIESEM Projekt, sonst nichts
---

## Ziel
Der Login wirft bei leerem Passwort einen 500er statt 400.

## Erlaubt
src/auth/

## Nicht anfassen
Alles andere. Keine neuen Abhängigkeiten.

## Fertig, wenn
- leeres Passwort gibt 400 mit Meldung
- npm run verify läuft grün

## Risiken
Die Session-Logik hängt daran.
```

- Schreib nur den Kontext rein, den der Agent wirklich braucht. Keine ganze
  Roadmap, kein README-Dump.
- `dependsOn` gilt nur innerhalb desselben Projekts. Ein Verweis auf ein anderes
  Repository wird immer abgelehnt, nie geraten.

---

## Teil C — jedes Mal, wenn du arbeitest

Immer diese Reihenfolge. Der Vorschau-Schritt ist nicht optional. Er kostet
Sekunden und verhindert die teuren Fehler.

### C1. Beide Repos sauber machen

```powershell
cd D:\AgentOrchestrator
git status --short -uall     # muss leer sein
npm run build                # nur nötig, wenn sich src\ geändert hat

cd D:\Pfad\Zum\Projekt
git fetch origin
git status --short -uall     # muss leer sein
git branch --show-current    # muss der Default-Branch sein
```

Kein zweites AO-Fenster auf demselben Projekt. Und keine Worktrees von Hand
anlegen — die macht AO selbst.

### C2. Vorschau ansehen

Ohne `--attended`. Startet keinen Agent, schreibt nichts, nimmt keine Sperre.

```powershell
cd D:\AgentOrchestrator
node .\dist\cli\index.js run --repository "D:\Pfad\Zum\Projekt"
```

Zeigt dir: welche Aufgabe dran wäre, warum, und was ihr gespeicherter Zustand
erlaubt. Sieht das falsch aus, korrigierst du **jetzt** die Task-Datei, nicht
mittendrin.

### C3. Wirklich starten

Derselbe Befehl, plus `--attended`. Das ist deine Unterschrift: „Ich habe das
gestartet und kann es stoppen."

```powershell
node .\dist\cli\index.js run `
  --repository "D:\Pfad\Zum\Projekt" `
  --task PROJ-001 `
  --attended
```

`--max-steps` lässt du weg. Der Standard ist 8.

---

## Mehrere Aufgaben oder mehrere Projekte

**Mehrere Aufgaben, ein Projekt, der Reihe nach.** Erst ohne `--attended` als
Vorschau, dann mit. Die Run-ID vergibst du selbst und nimmst für beide Aufrufe
dieselbe.

```powershell
node .\dist\cli\index.js block `
  --repository "D:\Pfad\Zum\Projekt" `
  --block PROJ-001 `
  --tasks PROJ-001A PROJ-001B `
  --run proj-001-20260906-01 `
  --attended
```

**Mehrere Projekte nebeneinander.** Hier gibt es kein `--repository`. AO nimmt
die Projekte, die du vorher registriert hast.

```powershell
node .\dist\cli\index.js repositories             # Vorschau
node .\dist\cli\index.js repositories --attended  # los
```

---

## Wie ein Lauf endet

Der wichtigste Unterschied: **Die Aufgabe kam nicht durch** ist etwas anderes als
**der Lauf kann nicht mehr sicher weiter**. Am Exit-Code siehst du sofort, was von
beidem los ist.

| Code | Heißt | Was du tust |
| --- | --- | --- |
| `0` | fertig, alles gut | Ergebnis ansehen |
| `1` | unerwartet — ein Fehler in AO selbst | Ausgabe sichern |
| `2` | deine Eingabe war unbrauchbar | Befehl oder Task-Datei korrigieren |
| `3` | ein Mensch muss hinsehen | erst lesen, dann handeln. Nichts löschen. |
| `4` | verweigert, aber nichts kaputt | Ursache beheben, später neu versuchen |
| `6` | falsche Node-Version | auf Node 22 oder 24 wechseln |

Ein erfolgreiches Blockende sagt `COMPLETE`. Das heißt: die Aufgaben sind sauber
abgeschlossen und aufgeschrieben. Es heißt **nicht** gemerged, nicht released,
und Worktrees und Branches sind noch da.

---

## Wenn es klemmt

**Zuerst: nichts löschen.** Nicht den gespeicherten Zustand editieren, keine
Worktrees wegräumen, nicht reflexartig die Sperre entfernen. Erst lesen.

### „Eine Sperre liegt und AO nimmt sie nicht"

AO lässt immer nur einen Schreiber pro Projekt zu. Nach einem Absturz bleibt
diese Sperre liegen. Erst nachsehen, wer sie hält:

```powershell
node .\dist\cli\index.js lease status --repository "D:\Pfad\Zum\Projekt"
```

- Steht dort, dass ein Prozess **lebt**: warten. Nicht abschießen — Prozess-IDs
  werden wiederverwendet, und AO kann dir nicht sagen, welcher Prozess der
  Eigentümer ist.
- Ist der Besitzer **weg** und die Lease beweisbar entfernbar: aufräumen lassen.

```powershell
node .\dist\cli\index.js lease recover --repository "D:\Pfad\Zum\Projekt"
```

AO entfernt nur, was es beweisen kann, und hat kein `--force`. Verweigert es,
sagt es dir, welche Tatsache ihm fehlt. Dann liegt die Datei unter
`<projekt>\.git\agent-orchestrator-execution-lease.json`, und sie von Hand zu
löschen ist deine Entscheidung, nicht die von AO. Die Frage dabei ist nicht „lebt
der Eigentümer noch", sondern: **läuft noch ein Agent-Prozess, den dieser Run
gestartet hat?**

### „AO fragt mich etwas und wartet"

Bei `HUMAN_DECISION_REQUIRED` und `BLOCKED_VERIFY` bleibt AO stehen. Hast du die
Sache selbst erledigt, sagst du ihm das:

```powershell
node .\dist\cli\index.js resolve `
  --repository "D:\Pfad\Zum\Projekt" `
  --task PROJ-001 `
  --attended
```

Das heißt genau eine Sache: **ein Mensch hat diesen Task beendet.** Nicht
verifiziert, nicht gemerged. Das kann AO nicht wissen und behauptet es deshalb
nicht.

### „Was liegt gerade an?"

```powershell
node .\dist\cli\index.js attention
```

Zeigt alles, was auf dich wartet. Leer heißt wirklich leer — kann AO die Liste
nicht lesen, sagt es das, statt „leer" zu behaupten.

---

## Was AO nicht für dich entscheidet

- **Ob ein Merge richtig ist.** AO kann einen Branch pushen, einen Pull Request
  öffnen und einen mergen — aber jede der drei Handlungen braucht ihr eigenes
  Flag (`--publish-head`, `--create-pr`, `--merge-pr`) und deine eigene
  Erlaubnis, und pro Aufruf passiert höchstens eine.
- **Wann eine Aufgabe „fertig" ist.** Der Endzustand heißt `READY_FOR_PR` und ist
  eine Sackgasse. Einen Zustand `COMPLETE` für eine Aufgabe gibt es nicht. AO
  reicht dir fertige Arbeit und hört auf.
- **Ob eine liegengebliebene Sperre gefahrlos weg kann**, wenn es das nicht
  beweisen kann. Dann fragt es dich.

---

## Kurzcheck vor jedem echten Lauf

```text
AgentOrchestrator
[ ] auf main, sauber, aktuell
[ ] npm run build, falls src\ sich geändert hat

Dein Projekt
[ ] auf dem Default-Branch, sauber, aktuell
[ ] runtime/ nachweislich ignoriert
[ ] kein zweites AO-Fenster darauf
[ ] keine fremde Sperre (lease status)

Die Aufgabe
[ ] Ziel klar formuliert
[ ] Scope minimal gehalten
[ ] Abnahmekriterien stehen drin
[ ] dependsOn stimmt

Dann erst
[ ] Vorschau gelesen und sie sah richtig aus
[ ] neue Run-ID vergeben (nur bei block)
[ ] --attended setzen
```
