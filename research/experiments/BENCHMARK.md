# cortex² benchmark

11 hidden synthetic configurations · 4 rounds · 1024 shots · K=8 validated hypotheses/round (32 forward simulations vs 256 for exhaustive search).

| provider | exact recovery | in consistent set | median loss / min | physical gates | TVD vs ideal |
|---|---|---|---|---|---|
| random | 0% | 9% | 8.82 |  |  |
| classical_anneal | 18% | 36% | 11.03 |  |  |
| thrml | 18% | 36% | 11.03 |  |  |
| aer_ideal | 9% | 27% | 11.30 | 107 | 0.116 |
| aer_noisy | 9% | 18% | 12.40 | 106 | 0.148 |

256 hypotheses are trivially enumerable classically; this measures sampler quality under a
fixed validation budget, not quantum advantage. Regenerate: `python experiments/benchmark.py`.
