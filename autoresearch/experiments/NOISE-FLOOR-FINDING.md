# The exam cannot detect the thing it was built to detect

Measured 2026-08-21 from the shared baseline `3009509.json` (release
2026-08-19.0) and the 60 retained attempts of `baseline-noise-run1-3009509`.
Pure analysis of an existing measurement: no quota spent, nothing re-run.

## The finding, in one line

A candidate scoring **perfectly** on correctness and struggle would gain
**0.039** on the objective. The noise floor is **0.117**. The floor is three
times the entire available prize, and it is a lower bound.

## The arithmetic

Baseline correctness is 0.9567, with 21 of 30 questions already perfect and
nine holding any headroom at all.

| | headroom | noise (p90) | verdict |
|---|---|---|---|
| correctness (w 0.45) | 0.0195 | 0.0450 | **drowned, 2.3x under** |
| struggle (w 0.35) | 0.0195 | 0.0183 | parity, 1.07x |
| token_efficiency (w 0.10) | 0.0500 | 0.0355 | 1.4x |
| wallclock (w 0.10) | 0.0500 | 0.0500 | **drowned, exactly at parity** |

Note the correctness ceiling on this branch is 0.0195, not the 0.0260 computed
against the original weights: this scorer demoted correctness from 0.60 to
0.45, which shrinks the prize as well as the penalty.

## The shape of the problem

**The exam is saturated where it is quiet, and noisy where it has room.**

Correctness and struggle barely wobble, and have almost nothing left to win.
Cost and speed have real headroom and are the two noisiest terms — together
they are 73% of the floor, and wallclock alone saturates its own scale at p90.

## The silent term never fires

`silent` carries 0.45 within struggle — the heaviest weight in this branch's
scorer — and fired in **0 of 58** usable attempts. Its baseline mean is 1.000,
headroom 0.0000.

It cannot reward a candidate for fixing silent failures, because this question
bank produces none. It remains a **guardrail** against a candidate introducing
them, which is a real job, but it is not a gradient. Roughly 70% of the
struggle term's weight sits on components that are near-constant here.

## Quarantining the unstable questions does not rescue it

Two questions swing wildly under the null — the identical tool, two repeats
minutes apart:

    ev-charging-gap          correctness |r1-r2| = 0.800
    bus-stops-with-coffee    correctness |r1-r2| = 0.600

Correctness is bimodal: median wobble 0.000, and a short tail that is enormous.
Excluding the worst questions helps and does not save it:

    excluded  questions  floor   vs headroom
    0         28         0.1166  3.0x
    2         26         0.0894  2.3x
    5         23         0.0576  1.5x

Removing enough questions to clear the floor would leave too few to constitute
an exam.

## More repeats will not fix it either

Noise falls with the square root of the sample, so closing a 3x gap needs about
9x the repeats — 18 per question rather than 2. That is roughly $135 per
baseline and the same multiple on every evaluation.

**The bank needs harder questions, not more measurement.** 21 of 30 already
score perfectly; the tool has outgrown its exam.

## What is still worth running

The registered prediction for this arm does not depend on the score moving:
whether GEPA, now able to read `core.py` but not edit it, names it with the S3
timeout parameters as its reason. `connect_timeout` and `request_timeout` exist
only in `core.py` (lines 232-233, 330-331, 591-592), which sits in
`NEVER_EVOLVE`. That result arrives through `blocked-files.txt` and is
unaffected by everything above.

## Caveats

- The floor is a **lower bound**. Both repeats ran minutes apart in one session,
  sharing a cache state, a network and a snapshot. Two separate runs would also
  carry drift across time. The true floor is higher, so the gap is worse than
  3x, not better.
- 28 of 30 questions paired. `building-parts-detail` had no usable repeat 1 and
  `waterfront-buildings-reykjavik` no usable repeat 2; both are named rather
  than dropped quietly.
- Any decision to quarantine unstable questions must be taken from this
  null-condition data, before any candidate is scored. Choosing exclusions
  after seeing candidate results would be selection, not calibration.
