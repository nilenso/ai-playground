# Why 3009509.json was moved aside

`3009509.json` was renamed to `3009509.release-2026-07-22.0.STALE.json`
on 2026-08-20.

It was measured on 2026-08-18 16:13 against Overture map-data release
**2026-07-22.0**. On 2026-08-19 release **2026-08-19.0** shipped. botmap is
unpinned and always resolves to the latest release, so any run started after
that date measures candidates against 2026-08-19.0 while comparing them to a
yardstick taken on 2026-07-22.0. The two are not comparable.

Left in place rather than deleted: it is still the correct reference for
`experiments/runs/tool-3009509-1787049966`, whose numbers were all taken on
2026-07-22.0.

Renamed (not deleted) so `baseline.load("3009509")` misses and forces a fresh
measurement, instead of silently reusing a yardstick from the wrong snapshot.

See TODO.md, "Runs are not pinned to a map-data snapshot" — this is that risk
firing for real.
