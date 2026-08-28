# READ BEFORE INTERPRETING ANY NUMBER FOR C1 (cand/count-zero-hint)

## C1 will score WORSE on `cli_error_count` because it is CORRECT

`evals/taxonomy.py`, exit-0 branch:

    if "did you mean:" in low:                          return "bad_category_value"
    if "0 rows" in low and "categories.primary" in low: return "bad_category_value"

At baseline, the failing command was scored **clean**:

    botmap count -t place --in Williamsburg --where categories.primary=bus_stop
      exit 0, count 0, no category signal on stderr
      -> classify_error() = None  ->  cli_error_count 0

C1 makes that same command emit `Did you mean: bus_station, ...`. The classifier
then returns `bad_category_value`, so the identical agent behaviour scores:

    cli_error_count  0 -> 1        (per affected call)
    wasted_commands  0 -> 1        (derived from the error count)

**This is not a regression. It is the fix registering as damage.** The silent
wrong answer -- the worst failure in the system, the one that made the agent
report "there are no bus stops in Williamsburg" -- scores clean. The diagnostic
that prevents it scores as an error.

## So how is C1 judged?

1. **Mechanism check** -- verified 2026-08-21, zero quota:
   hint fires on `bus_stop`, names `bus_station` FIRST, control (`coffee_shop`,
   1253) does not hint, and `places` still hints after the refactor.
2. **Recovery** -- does the agent reach an answer where it previously ran seven
   commands and gave up? Read the trace.
3. **Regression on stable questions** -- command counts on the ceiling seven.

**Never** on `cli_error_count` or `wasted_commands`.

## If someone later quotes C1's error count as evidence against it

They are quoting F11, not a property of C1. The number is real; what it
measures is the taxonomy's inversion, not the candidate's quality.

## Wider consequence (escalated to arm C)

Any optimiser scoring on error count has a gradient pointing at *deleting*
diagnostics. Arm C's struggle scorer weights silent failures heaviest and uses
the same exit-0 rule, so a hint-adding candidate would trip its heaviest
penalty by fixing the exact failure that penalty exists to punish.
