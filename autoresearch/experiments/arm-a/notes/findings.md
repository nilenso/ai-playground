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

## F7. A user-global skill shadows the project copy, voiding candidate evaluation

Across all 20 baseline runs, every transcript reported:

    Base directory for this skill: /Users/priyangapkini/.claude/skills/botmap

That is the user-global skill. Not one run loaded the project-scoped copy that
`evals/runner.py::install_skill` writes into its temp workdir. Moving the
global one aside and re-running confirmed the mechanism -- the agent then
loaded `/private/var/folders/.../T/eval-where-boston-.../.claude/skills/botmap`.

**Scope: candidate evaluation void; baselines unaffected** (the global and
project `skill.md` are byte-identical at 3009509, md5 5966be547cac5357d436e3a
03132fc79). A baseline measures the unchanged tool and the unchanged
instructions, and the unchanged instructions are exactly what was served. The
baseline stands.

Where it does bite is candidates. The moment a candidate rewrites
`botmap/data/skill.md`, the project copy diverges, the global one shadows it,
and the agent reads the unmodified text. Every prompt-lever candidate then
scores identically to baseline -- and that reads as "the prompt lever does not
help", which is a conclusion one might otherwise bank. Such a run is **void,
not negative**.

Both harnesses are exposed. `evals/runner.py:64` and
`autoresearch/runner.py:43` install to the same path, and neither
`claude -p` invocation passes any flag that disables user-scope skills.

Fix used here: move the global skill aside for the duration of a run. A better
fix is for the harness to neutralise user-scope skills explicitly, so the
measurement does not depend on what happens to be installed on the operator's
machine.

## F8. A non-answer scores as a clean pass

`containing-point` scored 2/2 completed with **zero** commands logged. The two
final answers were:

    "I'll wait for the background command to finish and report back with the results."
    "I've kicked off the lookup ... It's still running in the background"

The agent backgrounded the slow `containing` call (prior proposal #1 measured
that path at 637s), never waited, and returned a non-answer. `score.py` marks
`completed=True, run_status=ok` because a non-empty string came back and
`is_error` was false. Nothing checks that the tool was used, or that the answer
answers anything.

So real completion on the baseline is 16/20, not 18/20, and the suite's
headline number is inflated by a question that never ran a command.

A false pass is worse than a false negative: a false negative gets
investigated, a false pass is banked. Cheapest guard is to treat
`command_count == 0` as not-completed for any question whose `target_type`
requires the tool, which is all ten.

## F9. The suite cannot demonstrate an improvement: no question is both improvable and stable

Two full baselines, same tool, same commit, same instructions (byte-identical
skill.md), both verified clean -- 0 quota deaths, 0 curlCode 28, correct skill
loaded in 20/20 runs. The only difference is that they are two different draws.

Completion rate:

    busstops-coffee-williamsburg      0/2 -> 1/2   flipped
    containing-point                  2/2 -> 1/2   flipped
    hardware-near-bikepaths-alameda   2/2 -> 1/2   flipped
    (other seven)                     2/2 -> 2/2   unchanged
    TOTAL                            18/20 -> 17/20

Partitioning the ten questions:

    at ceiling (2/2 in both, no headroom to improve)      7
    unstable (outcome flipped with tool unchanged)        3
    BOTH improvable AND stable                            0

That last line is the finding. The only questions with room to improve are
exactly the ones whose outcome is unreliable, and the reliable ones are already
perfect. So no candidate can be shown to improve completion rate on this
suite: a gain on the unstable three is indistinguishable from a lucky draw, and
the other seven cannot gain at all.

Note this invalidates the decision rule in my own autoresearch-verify skill --
"one question flipping is noise; three is not". Three flipped here with nothing
changed. The rule was calibrated by intuition rather than measurement, which is
the same mistake in miniature that the whole harness makes.

**What remains usable.** Command count is far more stable than completion:

    7 of 10 questions had IDENTICAL mean command counts across the two runs
    only busstops (+3.5), pois-near-point (-1.0), hardware (+0.5) moved
    total CLI errors identical: 2 and 2

So the seven ceiling questions are excellent regression detectors -- their
command counts are exactly reproducible, so any perturbation is real signal.
And a targeted mechanism change (does `count --category X` still fail? does a
zero result now emit a hint?) can be verified deterministically without an
agent at all, at zero quota cost and zero noise.

Round 1 is therefore judged on: (a) deterministic mechanism checks, (b)
regression on the seven stable questions, and NOT on completion rate over the
unstable three.

## F10. Quota exhaustion is indistinguishable from a broken candidate

(Found by Arm B; corroborated here against nine independent quota deaths.
Numbered F10 rather than F9 because F9 was already assigned to the noise-floor
finding.)

When the shared Claude subscription runs out, the run ends with a `result`
event carrying a self-contradictory pair:

    is_error: True     subtype: "success"

and a body of "You've hit your session limit". Verified across all nine quota
deaths in `evals/runs/baseline-projectskill-QUOTA-VOID`: 9/9 carry exactly that
signature.

The harness reads `is_error` and records a failed attempt. At **baseline** that
becomes a skipped or failed question -- visible, and recoverable by re-running.
Inside a **GEPA run** there is no skip: it scores as correctness 0, which reads
as "this candidate broke the tool". GEPA would then spend budget repairing a
defect that never existed, and -- worse -- would learn to avoid whatever the
candidate happened to change.

Arm B lost a baseline to this today: questions 1-5 succeeded and 6-30 all
failed. A sharp cliff, not scatter. Scatter looks like a flaky tool; a cliff at
a fixed index is a resource running out.

**The obvious guard is insufficient.** Treating `command_count == 0` as
"void, not failed" catches most cases -- 8 of my 9 deaths hit at turn 1 having
run no commands. But one did not:

    containing-point__r2   turns=20   commands_logged=2   completed=False

That run died mid-work with real commands in its log. It is indistinguishable
from a candidate that started well and then failed, and no command-count guard
will separate them.

**Fix.** Detect the condition at its source rather than inferring it from
symptoms: treat a `result` event whose text matches the session-limit message
(or whose `is_error`/`subtype` pair is contradictory) as **void** -- neither
pass nor fail -- and refuse to score the attempt at all. A void attempt should
halt the run and say so, because continuing produces numbers that look like
measurements and are not. Scoring anything while the quota is exhausted is
strictly worse than stopping.

This belongs with F3, F5, F6 and F8: defects in the measuring apparatus, not in
botmap. That group is now the larger half of this arm's findings.

## F11. The scorer rewards silent failure and penalises diagnosis

`evals/taxonomy.py` on an exit-0 call:

    if "did you mean:" in low:                        return "bad_category_value"
    if "0 rows" in low and "categories.primary" in low: return "bad_category_value"
    return None

So a zero-result **hint** is recorded as an error. Verified against the
baseline, on the run that failed:

    botmap count -t place --in Williamsburg --where categories.primary=bus_stop
      exit 0, count 0, stderr carries only a place-resolution note
      -> classify_error() returns None  ->  CLEAN, cli_error_count = 0

That is the worst failure in the system -- the agent read 0 as "there are no
bus stops in Williamsburg" and spent its whole budget hunting -- and the scorer
recorded it as a clean call.

Now consider C1, which makes `count` emit the near-match hint that `places`
already emits. The identical command would then carry "Did you mean:
bus_station" on stderr, and `classify_error` would return
`bad_category_value` -- **+1 error, and +1 wasted_command**.

**The tool gets strictly better and the score gets strictly worse.**

The consequence for the whole project is larger than this one candidate. Any
optimiser scoring on `cli_error_count` -- GEPA included -- has a gradient
pointing at *removing* diagnostics. The cheapest way to a clean score is to
delete every "did you mean" in the codebase, and the eval would applaud. That
is a reward-hacking incentive built into the measuring instrument, not
something a candidate has to invent.

The intent behind the rule is defensible: a "did you mean" proves the agent
supplied a bad value, and that is a real mistake worth counting. But it counts
the mistake **only when the tool is helpful enough to point it out**, so it
cannot distinguish "the agent erred and recovered" from "the agent erred and
was told nothing". Those are the two cases the whole exercise is about.

Fix: score the *unrecovered* wrong value, not the diagnosis. A wrong category
followed by a corrected retry is a success story for the tool; a wrong category
followed by silence and a confident wrong answer is the failure. Both currently
score the same, and today the silent one scores better.

Consequence for round 1: C1 must NOT be judged on `cli_error_count`. It is
judged on the mechanism check and on whether the agent recovers.

## F12. `git stash -u` + a commit that succeeded while committing nothing

Recorded as a finding rather than an aside, because the shape is identical to
F5 and F9: a tool reported success while doing nothing.

Verifying C3's baseline claim meant checking out the base branch, so I ran
`git stash -u`, ran the comparison, checked the candidate branch back out --
and never popped the stash. The subsequent `git add && git commit` then
printed:

    On branch cand/count-flag-parity
    nothing to commit, working tree clean
    committed: 87e2c7c Add. autoresearch loop skills for arm A

Both lines are true and together they are a lie: the commit did not fail, it
had nothing to commit, and the "committed:" line echoed the *previous* HEAD.
Exit status was 0.

Had it gone unnoticed, `cand/count-flag-parity` would have been an empty
branch identical to base. It would have screened as **"no effect"** -- a
perfectly plausible result for a small CLI change -- and I would have written
up "flag parity did not help" as a finding. The candidate would have been
recorded as tested and refuted without ever having existed.

Caught only because the commit hash did not move between two lines of output.
That is luck, not process.

Guard adopted: after committing a candidate, assert the branch actually differs
from base --

    git diff --quiet arm-a-base <branch> && echo "EMPTY CANDIDATE -- do not measure"

An empty candidate must never reach measurement. This is cheap, and the class
of bug it prevents -- a null change scoring as a tested negative -- is exactly
what quietly corrupts an optimisation loop's record of what it has ruled out.

## F13. Agent-to-agent coordination produced authoritative, wrong instructions

Three arms ran concurrently, each inheriting `HERDR_ENV` and each able to run
`herdr agent prompt` against the others. We used it. The orchestrator
intercepted **five** cross-arm messages that were confidently worded and wrong:

    "arm B's baseline just landed clean — you're released, start round 1"   (was 15/30)
    "run the noise floor once arm B's baseline lands"        (that is arm B's work)
    "baseline landed, run reconcile"                                       (was 19/30)
    "baseline landed at experiments/baselines/3009509.json — run reconcile"(was 21/30)
    "run that ceiling/unstable partition on arm B's two baselines"  (only ONE exists)

Every one was plausible. Every one was wrong on a detail visible only from the
orchestrator's position. The fourth names an exact file path, which makes it
*more* convincing and more dangerous: had it been acted on, arm C would have
reconciled against `3009509.INCOMPLETE-5of30.json` -- a yardstick missing 25 of
30 questions, renamed specifically so nothing could pick it up by accident.

I sent three such messages myself, and authored the premise behind the fifth: I
asserted "arm B will have two baselines" as the basis for a proposed next step.
There is one. Run 2 was cancelled. I never checked; checking was one `ls`.

**Why this belongs with F3, F5, F8, F10 and F12.** Each is a message that
*looks* authoritative while resting on state that has since moved:

    a cached baseline that looks like a valid yardstick     (F3)
    a probe that reads a usage error as "cache broken"      (F5)
    a non-answer that scores as a clean pass                (F8)
    a quota death that scores as a broken candidate         (F10)
    a commit that reports success having committed nothing  (F12)
    an agent telling another agent a run has finished       (F13)

The failures are all biased in the same direction -- **toward looking fine**. A
system whose failure modes are biased toward false confidence will
systematically overstate what it has verified, which is worse than one that is
merely noisy. That bias, not the individual bugs, is the finding.

**What actually fixes it** is not "be more careful". No arm can see another's
true state; each has only its own inference, and an inference stated to a peer
arrives indistinguishable from a fact. The fix is structural: a single position
that can observe true state, all coordination routed through it, and a cheap
local check (`ls` the file) before believing any claim about shared state.

## F9b. Both exams are saturated where it matters (botmap suite, measured)

The orchestrator computed the ceiling for autoresearch's 30-question bank:
baseline correctness 0.957, so the maximum achievable correctness gain is
(1.000 - 0.957) x 0.60 = **0.026 on the objective**, and only 9 of 30 questions
have any headroom at all.

The same computation for botmap's 10-question suite:

    baseline (clean)   17/20 completed = 0.850
    maximum possible   20/20           = 1.000
    HEADROOM                             0.150   (3 run-slots)

Which questions hold that headroom:

    busstops-coffee-williamsburg      1/2   UNSTABLE
    containing-point                  1/2   UNSTABLE  + F8: "completes" with 0
                                                        commands and a non-answer
    hardware-near-bikepaths-alameda   1/2   UNSTABLE

    headroom questions with room to improve : 3
    of those, unstable                      : 3
    of those, STABLE                        : 0

Every slot of available improvement sits on a question that changes its own
answer between identical runs. Measured churn between two clean baselines was
3 questions flipping. So:

    maximum possible gain : 3 run-slots
    observed churn        : 3 run-slots
    ratio                 : ~1.0

**A perfect candidate and a lucky draw are the same size.** And one of the three
is worse than that: `containing-point`'s completion score is invalid under F8,
so genuine headroom is 2 questions, not 3.

### The answer to the question that was asked

Is a 0.026 correctness gain detectable? **On botmap's suite the equivalent gain
is not detectable, and I can state that as measurement rather than worry.** For
autoresearch's bank I cannot answer -- that needs arm C's within-run floor --
but the structural condition is identical and worse in one respect: 21 of 30
questions are already perfect, so 70% of that exam can only move downward.

Two exams, built independently, both saturated at the point where the thing
being optimised would have to show up. That is not a coincidence to work
around; it is a property of grading agent behaviour with a small bank of
questions an already-competent agent mostly answers. Any measured "improvement"
smaller than the churn is a draw, not a result.

## F14. Adversarial review found three defects the mechanism check could not

The reward-hack sub-agent returned **GENUINE** on C1, reaching independently
the argument F11 makes: the change is *self-penalising*. It makes
`cli_error_count` and `wasted_commands` worse, so it cannot be a reward hack --
a hack improves the score. That a candidate can only be exonerated by proving
it damages its own metrics is a compact statement of what is wrong with the
scorer.

It also found three correctness defects that mechanism checks are structurally
blind to, because a mechanism check asks "does the change do what it claims?"
and never "what else did it touch?".

**(a) Cost regression on the verb advertised as cheap.** `_suggest_categories`
calls `record_batch_reader(...)` with no column projection, so it streams every
column -- geometry, names, addresses, brands -- for the whole bbox. In `places`
that was free: the caller had already paid for a full read. `count` is the
pre-flight you run *instead of* downloading, so one typo'd category on
`count -t place --in "California"` now pulls a large fraction of the partition
to print one yellow line. Fix: `columns=["categories"]`.

**(b) An empty bbox is reported as a bad category value.** `_prepare_query`
returns None when STAC finds no intersecting files, so `count_rows` returns 0
before the where-filter is validated. The hint then says
`categories.primary='cafe' is not present in this bbox` when the truth is
"there is no place data in this bbox at all". The agent chases spellings
instead of widening the box. Pre-existing in `places`; the candidate attaches
it to the first command the Skill tells agents to run.

**(c) A dead end I introduced while "generalising".** The base hardcoded
`place` in the recovery command. I interpolated `{type_}` to make it general.
But `categories` supports only `place` -- its own help says so -- so for every
other type the hint now names a command that cannot work. I made a correct
message wrong by broadening it, and neither the mechanism check nor the eval
would ever have caught it: no eval question counts a non-place type by
category. Fixed post-review; the fix is NOT in the measured commit (99d993f).

**One reviewer claim did not survive checking.** It reported that `skill.md`
teaches `--category cafe` while the real value is `coffee_shop`, inducing the
very error C1 catches. Measured: `cafe` returns 950 and `coffee_shop` returns
1253. Both are real, populated categories. The example is a different choice,
not a trap. Recorded because an adversarial reviewer's findings need the same
verification as anything else -- it was right about three things and wrong
about a fourth, all in the same confident register.
