"""Bootstrap confidence intervals — report ranges, not point estimates.

On ~25 examples per stratum an LLM-judge mean is noisy; a single number invites
over-reading a 0.02 wobble as a real change. Slice 6 reports a 95% bootstrap CI
beside every mean so a delta is only believable when the intervals separate. The
resampler is seeded, so the CI is reproducible run to run.
"""

from __future__ import annotations

import random
from statistics import mean


def bootstrap_ci(
    values: list[float],
    *,
    confidence: float = 0.95,
    n_boot: int = 2000,
    seed: int = 42,
) -> dict:
    """Return mean and a percentile bootstrap CI for ``values``.

    ``{"mean", "lo", "hi", "n"}``; ``lo``/``hi`` are ``None`` for n < 2.
    """
    clean = [float(v) for v in values if v is not None]
    n = len(clean)
    if n == 0:
        return {"mean": None, "lo": None, "hi": None, "n": 0}
    m = mean(clean)
    if n < 2:
        return {"mean": m, "lo": None, "hi": None, "n": n}

    rng = random.Random(seed)
    boots = []
    for _ in range(n_boot):
        sample = [clean[rng.randrange(n)] for _ in range(n)]
        boots.append(mean(sample))
    boots.sort()
    lo_idx = int((1 - confidence) / 2 * n_boot)
    hi_idx = int((1 + confidence) / 2 * n_boot) - 1
    return {"mean": m, "lo": boots[lo_idx], "hi": boots[hi_idx], "n": n}
