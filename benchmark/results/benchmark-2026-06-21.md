# Darwin Evolution Benchmark — 2026-06-21

```

Results  (10 tasks × 3 runs/cell, scores = mean per cell)
──────────────────────────────────────────────
Task                   baseline   evolved
tech-locking               8.00      8.33
market-sdk-launch          5.00      6.00
webdesign-emptystate       7.00      7.67
tech-idempotency           7.00      7.00
market-linkedin-hooks      7.67      7.00
tech-indexing              7.67      7.33
market-cold-email          7.00      6.67
webdesign-404              8.00      7.33
business-explain-exec      6.00      7.00
tech-cache-invalidation     7.67      8.00
──────────────────────────────────────────────
AVG                        7.10      7.23

Evolved prompt beat baseline by +0.13 points across 10 held-out tasks (3 runs/cell).
Small task counts stay noisy even when averaged — this is a reproducible harness, not a significance test.
```
