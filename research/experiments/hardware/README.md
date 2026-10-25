# Hardware runs (2026-10-25)

Synthetic hidden configuration `10101011` (alpha rhythm), trust-region QUBO around `00000000`, p=1 QAOA, 1024 shots.

## IonQ (cloud simulator, `forte-1` noise model) — `ionq_simulator_10101011.json`

| circuit | target | physical gates | 2q gates | 2q depth | within 130 | TVD vs ideal |
|---|---|---|---|---|---|---|
| full QAOA (all 28 couplings) | IonQ (all-to-all) | 52 | 28 | 18 | yes | 0.174 |
| full QAOA (all 28 couplings) | IBM heavy-hex (Aer, fake_torino noise) | 454 | 112 | 81 | **no** | 0.212 |
| pruned to 6 couplings | IonQ | 30 | 6 | 4 | yes | 0.166 |
| pruned to 6 couplings | IBM heavy-hex | 106 | 15 | 11 | yes | 0.197 |

The IonQ job IDs are listed in the JSON. Because trapped ions are all-to-all connected, the *unpruned* Ising problem fits the
gate budget on IonQ. IBM routing quadruples the gate count.

**IonQ QPU path.** Validated without charges:
- Cost estimate for the full circuit on `qpu.forte-1`: 11.53 credits, about 37 s execution, about 12.5 h predicted queue.
- Server-side dry run: **403**. The IonQ project does not have `qpu.forte-1` enabled (Project Settings → QPU
  Targets), and this API key reports `has_access: false` for every QPU. Aria-1 and Aria-2 are retired.

## IBM (`ibm_kingston`) — `ibm_dbf6f58m94ac738suqa0.json`

The in-budget circuit transpiles on the real Heron targets (`ibm_fez`, `ibm_kingston`) to **102 physical gates, 15 CZ, 2q depth 11**.
The full QAOA transpiles to about 407 gates.

We submitted one real SamplerV2 job through the cortex² runner: `dbf6f58m94ac738suqa0`. It is **QUEUED**, because the IBM
instance ("Hanah") had already used 703 s of its 600 s Open-plan allowance, and time is next available on 2026-11-07.
The app now refuses IBM submissions while the quota is exhausted, and reports why in the backend catalog.

To retrieve the result later:
```python
from cortex2 import quantum as qm
qm.poll_ibm("dbf6f58m94ac738suqa0")
```
