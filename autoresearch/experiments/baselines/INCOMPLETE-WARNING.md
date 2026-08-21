# 3009509.json was withdrawn — DO NOT USE

Measured 2026-08-20 on release 2026-08-19.0 and it FINISHED, but only
5 of 30 questions produced a usable reading. Renamed to
`3009509.INCOMPLETE-5of30.json` so `baseline.load()` misses rather than
silently returning a yardstick with 25 questions absent.

Questions 1-5 succeeded; everything from #6 on failed. A sharp cliff, not
a random scatter -- consistent with the subscription quota running out
mid-run, not with anything about the tool.

ARM C: do not load this. A fresh measurement is needed.
