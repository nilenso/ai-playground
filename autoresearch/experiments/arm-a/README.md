# Arm A — findings

Copied here from the botmap working clone, where they were deliberately kept out
of version control via `.git/info/exclude`. That was the right call: these are
experiment findings, and they belong with the experiment rather than inside a
fork of the tool being experimented on.

The **code** — three loop skills and three candidate branches — lives in the
fork instead: `PriyangaPKini/botmap`, branches `arm-a-base`,
`cand/count-flag-parity`, `cand/count-zero-hint`, `cand/skill-bus-station`.

| File | What it is |
|---|---|
| `AUTORESEARCH-REPORT.md` | the arm's own report, including findings F1-F6 in full |
| `notes/findings.md` | all fourteen findings, F1 through F13 plus F9b |
| `notes/round1-candidates.md` | the three competing candidates as proposed |
| `notes/round1-mechanism-results.md` | mechanism verification, no model spend |
| `notes/C1-MEASUREMENT-CAVEAT.md` | why C1 scores worse for being correct (F11) |
| `notes/cross-score-plan.md` | plan to score arm A's winners on the shared bank |
| `notes/minibatch.yaml` | the shared mini-batch used to screen candidates |

Read `notes/findings.md` first. Nine of the fourteen are defects in the
measuring apparatus rather than in botmap, which is the result that redirected
the whole project.
