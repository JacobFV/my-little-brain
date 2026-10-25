# cortex² benchmark

11 hidden synthetic configurations · 8 rounds · 1024 shots · K=8 new hypotheses validated per round
(≤64 forward simulations vs 256 for exhaustive search; random search without replacement is expected to
simulate the truth with probability 64/256 = 25%).

| protocol | exact recovery | in consistent set | median loss / min | forward sims used | mean approx. ratio | physical gates | TVD vs ideal |
|---|---|---|---|---|---|---|---|
| random_unseen | 3/11 (27%) | 5/11 (45%) | 3.24 | 64.0 |  |  |  |
| anneal · trust_region | 2/11 (18%) | 4/11 (36%) | 11.03 | 5.5 | 0.89 |  |  |
| thrml · trust_region | 3/11 (27%) | 5/11 (45%) | 6.35 | 64.0 | 0.662 |  |  |
| aer_ideal · trust_region | 2/11 (18%) | 4/11 (36%) | 11.03 | 64.0 | 0.585 | 107 | 0.109 |
| aer_noisy · trust_region | 2/11 (18%) | 4/11 (36%) | 11.03 | 64.0 | 0.538 | 106 | 0.147 |
| anneal · surrogate | 3/11 (27%) | 5/11 (45%) | 6.35 | 13.4 | 0.865 |  |  |
| aer_noisy · surrogate | 5/11 (45%) | 7/11 (64%) | 1.00 | 64.0 | 0.404 | 103 | 0.154 |

**Reading this honestly.**
- 256 hypotheses are trivially enumerable classically; this measures sampler quality under a fixed
  forward-simulation budget, not quantum advantage.
- With 11 configurations per protocol, differences of one or two recoveries are within noise.
- Approximation ratio = (E_uniform − E_samples)/(E_uniform − min) of the nonlinear loss under the sample
  distribution: 1 = all probability on the optimum, 0 = no better than uniform.
- Even the best possible quadratic surrogate (fitted on all 256 states) ranks the truth only ~3rd–9th on
  these landscapes, which caps every QUBO-based protocol.

Regenerate: `python research/experiments/benchmark.py --rounds 8 --seeds 8` (1188 s on the authoring machine).
