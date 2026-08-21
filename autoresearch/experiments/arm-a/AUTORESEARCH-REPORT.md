# Arm A — autoresearch loop (INTERIM: paused before baseline)

**Status:** paused on 2026-08-20 before measuring the baseline. The loop has
not run. No candidate has been proposed, implemented or scored. One smoke
run was executed; nothing else consumed `claude -p` quota.

**Why paused:** the network fails ~50% of botmap's S3 calls, and the eval
taxonomy records those failures as `traceback` — indistinguishable from real
botmap bugs. Any baseline measured in that state would have the connection as
its dominant failure cluster, and candidates would be scored on network luck.
See F6.

## What Arm A was testing

Whether an agent *instructed* to apply GEPA's strategies — mini-batching,
2-3 competing candidates, Pareto selection, sub-agent reward-hack checks —
matches GEPA's coded scaffolding. That question is still open.

## Environment prepared (survives the pause)

- Isolated clone at `3009509`, deps installed, tool starts.
- Divisions index rebuilt for the current release:
  `2026-08-19.0`, 4,658,700 rows, 332.8 MB, `up_to_date: true`.
  Verified readable via parquet metadata, installed with an atomic `os.replace`.
- Editable install confirmed, so prompt-lever edits to `botmap/data/skill.md`
  are actually measurable.
- Driver at `/tmp/ar-a/run_evals.py` reproduces `evals/runner.py::main()`
  minus the broken `ensure_cache` (F5). `evals/` is unmodified.
- Aggregator at `/tmp/ar-a/agg.py`.

## To resume

```bash
# 1. confirm the link is healthy — 6 identical calls, expect 6/6 ok
cd ~/workspace/ar-a/botmap
for i in 1 2 3 4 5 6; do uv run python -m botmap --json count -t place \
  --in "Brooklyn, US-NY" --where categories.primary=coffee_shop >/dev/null 2>&1 \
  && echo ok || echo FAIL; done

# 2. baseline (10 questions x 2 repeats)
uv run python /tmp/ar-a/run_evals.py evals/runs/baseline "" 2 sonnet
uv run python -m evals.score --runs-dir evals/runs/baseline
uv run python /tmp/ar-a/agg.py evals/runs/baseline
```

Then follow `.claude/skills/autoresearch-loop/SKILL.md` from step 2.

---

# Arm A — findings outside the optimisation loop

## F1. `cache.py:213` writes the divisions index non-atomically (robustness bug)

`build_index()` ends with:

    out = index_path(release)
    out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(joined, out)      # botmap/cache.py:213

It writes a ~330MB parquet **straight to its final path** — no temp file, no
atomic rename. Two consequences, both silent:

1. **Concurrent builds corrupt each other.** The cache is shared per-user at
   `~/.cache/botmap/`, so any two botmap processes that both find the index
   stale will build and write the same path at the same time.

2. **A failed build leaves a valid-looking file.** `ensure_index()` decides by
   `target.exists()`. If a build dies partway through the write — network
   drop, timeout, Ctrl-C — the truncated parquet is still *present*, so every
   later run treats it as a good index. The failure surfaces later, somewhere
   unrelated, as a parquet read error or wrong data.

Fix: write to `out.with_suffix(".parquet.tmp")` (or a `tempfile` in the same
directory) and `os.replace()` onto the final path. `os.replace` is atomic
within a filesystem, which gives both properties at once: concurrent builders
race harmlessly, and a crashed build leaves no file rather than a bad one.

Found while running the loop, not by it — independent of the experiment.

## F2. The eval question bank is stale relative to the tool

`evals/questions.yaml` marks `water-downtown-boston` and `landuse-brooklyn` as
`download_is_legitimate: true`, noting "No convenience verb for water". But
botmap at 3009509 ships both `water` and `landuse` commands.

This does not create a false penalty — neither path is punished — but those two
questions can no longer distinguish a good agent from a bad one on the download
axis, which is the suite's headline metric. Two of ten questions are inert.

Left alone deliberately: the exam is not ours to edit.

## F3. A data-release boundary invalidated a concurrent run

Overture published `2026-08-19.0`; the shared cache held `2026-07-22.0`.
botmap always uses the latest release and cannot be pinned, so a baseline
measured before the boundary is not comparable to anything measured after it.
Arm B, reusing an 18 Aug yardstick, scored 0.187 against a 0.764 baseline with
correctness at ~0 — the mismatch, not a bad candidate.

## F4. Only `download` can set S3 timeouts; every purpose-built verb cannot

Corrected from an earlier, wrong version of this note. botmap does have timeout
plumbing -- `core.py` threads `connect_timeout`/`request_timeout` through every
S3 read -- but it defaults both to `None`, and `None` tells PyArrow "use your
default", which is ~1s connect and ~3s request.

Those two values are exposed as flags on exactly one command:

    botmap/cli.py:494-495   @click.option("--connect_timeout", ...)
                            @click.option("--request_timeout", ...)
                            def download(...)

Checked across the CLI:

    download                                          --connect_timeout: YES
    count places buildings roads water landuse
    addresses at sample                               --connect_timeout: no

`cache.py:91` is worse still -- it constructs `S3FileSystem(anonymous=True,
region="us-west-2")` with no timeout arguments at all and no caller able to
supply them, which is why a cold index build cannot be made to survive a slow
link without patching PyArrow from outside.

The shape of this is the interesting part. The one command with an escape hatch
is the bulk `download` -- the command the eval suite exists to push agents
*away* from. Every convenience verb an agent is supposed to prefer inherits a
3s timeout it cannot change. So on a slow connection the tool quietly rewards
exactly the behaviour it is trying to discourage: `download` can be made to
work, `count` cannot.

Two smaller things in the same place: the flags use underscores
(`--connect_timeout`) where every other flag in the CLI uses hyphens, and a
timeout failure surfaces as an unhandled PyArrow `OSError` with the curl detail
buried at the end of a stack trace, rather than as a message naming the problem
and suggesting a retry. curlCode 28 is transient by definition; nothing retries.

## F6. Measured failure rate on a degraded link makes the suite unusable

Six identical `count -t place --in "Brooklyn, US-NY"` calls, stock botmap:

    72s TIMEOUT   102s TIMEOUT   128s TIMEOUT   60s ok   79s ok   40s ok

50% failure, all curlCode 28, all recorded by the taxonomy as `traceback` --
indistinguishable from a genuine botmap bug. Raising the timeouts from outside
did not rescue it: latencies for the same call ranged 17s to 259s.

Consequence for the experiment, not for botmap: a baseline measured in this
state would have my network as its dominant failure cluster, and any candidate
"improvement" would be luck of the draw. Also note a single call can exceed
4 minutes against a 900s per-question budget, so multi-step questions time out
on wall-clock alone.

## F5. `--json` only works before the subcommand, and it breaks the eval harness

`--json` is a group-level flag, not a per-command one:

    botmap --json where "Brooklyn, US-NY"    -> exit 0
    botmap where "Brooklyn, US-NY" --json    -> exit 2 (usage error)

The second is the form an agent reaches for first, and `where --help` lists
`--all` and `--geometry` without hinting `--json` exists. Prior proposal #9
flagged the same thing in the Skill's examples.

It also breaks the eval harness in two places, both building that exact
malformed command:

    evals/runner.py:52  ensure_cache  -> probe can never return 0
    evals/runner.py:73  cost_guard    -> probe can never return 0

So `ensure_cache` rebuilds the 330MB index before every batch however fresh the
cache is (reading the usage error as "cache broken"), and `cost_guard` never
guards -- it returns True on a failed probe, making `--strict-cost-guard`
silently inert. Neither is visible from outside: one looks like a slow eval,
the other like a guard with no cause to fire. Same silent-failure shape the
project exists to find, sitting in the measuring instrument.

Left unedited: `evals/` is the exam.
