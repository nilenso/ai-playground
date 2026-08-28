# autoresearch

Makes the `botmap` command-line tool easier for an AI to drive — automatically.

## The idea in one minute

`botmap` answers questions about map data. Its users are AI assistants, not
people. An assistant gets a plain-English question — *"how many hospitals are in
Rhode Island?"* — and a shell, and has to work out the right command by itself.
Nobody tells it which command to use. **Working that out is the whole test.**

So this doesn't check whether the tool returns correct data. It checks whether
an AI can *find its way around* the tool. A tool that's easy to drive scores
well; a confusing one scores badly even if every answer it gives is right.

Then [GEPA](https://arxiv.org/abs/2507.19457) rewrites the tool to make the
score go up.

## Published dataset and experiment trail

The dataset, raw run artifacts, arm reports, worktree patches, and compact
summaries are published at:

```text
https://huggingface.co/datasets/nilenso/autoresearch
```

The local publication index is:

```text
experiments/published/agent-friendly-cli-experiment-20260825/README.md
```

Start there for the documented trail of the agent-friendly CLI experiment,
including the baseline measurement, paired before/after experiments, Arms A–D,
and the derived principles.

## How the loop works

```
GEPA rewrites botmap/cli.py
        │
        ▼
we drop that version into a private copy of the tool
        │
        ▼
an AI is asked real map questions against it
        │
        ▼
we score it, AND write down every command it ran and every error it hit
        │
        ▼
GEPA reads that write-up and works out what to change next
```

The write-up is the important part. If we only handed GEPA a number, it would
be guessing. Handing it *"the assistant typed `botmap count --category cafe` and
got back 0 rows with no explanation"* tells it exactly what to fix. That's why
GEPA needs far fewer attempts than trial and error.

## Running it

```bash
uv sync
echo 'OPENROUTER_API_KEY=...' >> .env  # the model that proposes changes
python -m autoresearch.smoke          # free, ~1 min: checks the machinery
python -m autoresearch.optimize --lever tool --budget 60
```

Nothing is ever applied to your checkout. You get the best version it found and
a patch, and you decide.

| Setting | Default | |
|---|---|---|
| `--lever` | `tool` | which file to evolve: `tool` (the code) or `prompt` (the instructions) |
| `--budget` | `60` | how many candidate evaluations to allow |
| `--holdout` | `0.2` | share of questions kept back to check it didn't just memorise |
| `--reflection-lm` | `openrouter/anthropic/claude-opus-5` | the model that proposes changes |
| `--workers` | `1` | parallel evaluations (each needs its own copy of the tool) |
| `BOTMAP_REPO` | `~/workspace/botmap` | the tool under test |
| `--all-files` | off | edit every tracked UTF-8 tool-repo file except evaluator/yardstick files |
| `--full-repo-context` | off | include bounded read-only full-repo context in GEPA's prompt |

Keys are read from `.env` in this directory, so a checkout is self-contained
and nothing has to live in your shell profile. An already-exported variable
wins, which is how you override one key for a single run. Everything goes
through OpenRouter, so switching `--reflection-lm` to another provider's model
needs no second credential. The smoke check fails immediately if the key is
missing, rather than letting a run reach the first proposal and die there.

## What it costs

One evaluation = one question, asked twice ≈ **$0.50 and ~3 minutes**.
A 60-evaluation run ≈ **$30 and a few hours**, plus a one-off **$15** the first
time to measure the unchanged tool.

That's the honest weak spot. GEPA's published wins come from problems you can
grade in a second for free — compile a program, time it. Here, grading means
asking an AI a question and waiting. Two things follow:

- **Start small.** `--budget 20` first, to see whether anything moves at all.
- **The grader wobbles.** Ask the same question twice and the AI won't behave
  identically. So a candidate scoring slightly higher may just have got lucky,
  and GEPA can chase that luck. Treat small gains with suspicion until the
  scoring is made exact — see `TODO.md`, which is local-only.

## Two levers, one at a time

There are two ways to make the tool easier to drive:

| Lever | Files | The question it answers |
|---|---|---|
| `tool` | `cli.py`, `filters.py`, `geocoding.py`, `introspection.py` | does a better-designed command help? |
| `prompt` | `data/skill.md` | does explaining it better help? |

A lever is a **set** of files, not one file, because most real improvements
don't live in `cli.py`. The `--where` grammar is in `filters.py`, place
resolution is in `geocoding.py`, and the `--class` values the tool advertises
are in `introspection.py`. Restricting the tool lever to `cli.py` would put
four of the five worst known problems out of reach.

That doesn't mean sprawling diffs: GEPA changes **one file per round**, so each
proposal still touches a single file and you can still say which one moved the
score.

`core.py` is deliberately left out. It's the data-access plumbing, so a bad
edit breaks every command at once, and its main known problem is latency, which
our scoring only sees indirectly.

### When the fix is in a file GEPA can't reach

GEPA can only rewrite the files you hand it — it cannot invent new ones, and it
cannot reach a file you left out. So if the real cause of a failure sits
elsewhere, it has three bad options: patch around it somewhere it *can* edit,
give up, or keep proposing the same doomed change. From outside, all three look
identical — the run just underperforms.

Two things stop that being invisible:

**GEPA is told it's constrained**, and asked to name the file when the fix is
elsewhere rather than papering over it.

**Its reasoning is read back afterwards**, and sorted into two buckets that
need different fixes. Both land in `blocked-files.txt` and `summary.json`.

*An existing file we left out* — just add it next run:

```
GEPA REFERRED TO EXISTING FILES IT COULD NOT EDIT
  botmap/core.py                     mentioned 11x
  --files botmap/core.py <the files you already had>
```

*A file that does not exist* — this one is worse, because GEPA can **never**
create a file. The set it can edit is fixed before the run starts, so this
failure repeats forever until you notice:

```
GEPA WANTED FILES THAT DO NOT EXIST

  botmap/boundary.py                 asked for 4x
      why: the polygon logic does not belong in cli.py

  touch botmap/boundary.py
  python -m autoresearch.optimize --files botmap/boundary.py <your existing files>
```

Empty is fine — GEPA fills it in. Keep whichever file would import the new
module in the list too, or nothing will reference it.

To make this reliable rather than guesswork, GEPA is taught an exact line to
write when it needs a file:

```
NEW FILE NEEDED: botmap/boundary.py - the polygon logic does not belong in cli.py
```

Unstructured mentions are picked up as well, but the marker is what carries a
reason. Mentions aren't proof — read `run_log.txt` before acting.

### Choosing the file list

```bash
--lever tool                              # the curated four
--files botmap/filters.py                 # narrow and deep
--all-files --full-repo-context --budget 200  # broad edit surface + broad read context
```

`--all-files` is intentionally not allowed to edit the evaluator/yardstick
surface (`evals/*`, `tests/eval_fixtures/*`, `tests/test_eval_*`). Full-repo
context is read-only; changing the exam is not a valid improvement.

Widening costs depth. GEPA splits its budget evenly across files, so a broad
file list with `--budget 60` can find very little. The optimiser warns you when
the arithmetic drops below ~8 per file.

A good pattern is two passes: go wide and cheap first to see which files GEPA
actually pulls on, then narrow to those and spend the real budget.

**Only one per run.** If you changed both and the score moved, you'd have no
idea which one moved it. Run it twice and compare — that comparison is worth
more than either run on its own, because it tells you where effort actually
pays off.

## Why questions are held back

GEPA optimises against most of the questions, and is scored on a handful it has
never seen. Without that you'd only learn that it can memorise the questions you
gave it.

The split is the same every run (every Nth question, not shuffled) and both
halves cover every difficulty tier — otherwise the held-out score could be
accidentally all-easy.

## The pieces

| File | What it does |
|---|---|
| `optimize.py` | the loop — hands the file and the scorer to GEPA |
| `evaluator.py` | scores one candidate on one question, and writes the feedback |
| `runner.py` | asks the AI one question and records everything it did |
| `agenteval/` | record-v2 evaluator: taxonomy, probes, sabotage fixtures, scoring, enrichment, and explanations |
| `score.py` | legacy scoring helpers retained for compatibility |
| `baseline.py` | measures the unchanged tool once, as the yardstick |
| `worktree.py` | private copies of the tool, so runs can't tread on each other |
| `shim/botmap` | sits in front of the real tool and logs every command |
| `trace.py`, `taxonomy.py` | read the logs; put a name to each failure |
| `questions.py`, `config.py` | loads the questions; holds the settings that must not vary |
| `smoke.py` | checks every seam before you spend anything |

## Where things live

```
experiments/
├── questions.yaml      the 30 questions — the only input the loop reads
└── proposals.json      20 known bugs, for you to read (see below)
```

**`proposals.json` is a reading list, not an input.** Under the previous design
a separate agent read it and applied the changes one at a time. GEPA doesn't
work that way — it reads execution traces and writes its own changes — so
nothing in the code opens that file.

It's still worth having, for two reasons. Several entries are one-line fixes
you could do by hand in minutes. And it doubles as a scorecard: if a run
independently finds something on that list, that's real evidence the loop
works.

## Guards worth knowing about

**A broken candidate is caught in one second.** Before asking any questions we
check the file still compiles and the tool still starts. A candidate that can't
run scores zero immediately instead of burning $0.50 on 30 tracebacks — and
GEPA is told *why* it failed, so it can fix it.

**Speed and cost are scored against the unchanged tool, where 0.5 means "the
same".** Not against an all-time best: everything would sit at or below the
ceiling, so those terms could only ever punish, and a genuinely faster tool
would look identical to one that hadn't changed.

**The AI reads the instructions from the private copy**, not from the installed
package. Otherwise a change to the instructions would have no effect, and the
result would look like an honest "no difference" rather than a broken test.
