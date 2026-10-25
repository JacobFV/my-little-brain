# Campaign: CHB-MIT chb01_03 T7-P7 ictal

Agent information: **blind** (search-side only) · model chain head: `gemini/gemini-4-argon (GEMINI_API_KEY)` · providers that answered: `gemini/gemini-4-argon (GEMINI_API_KEY)` ×5

**Baseline** (naive in-budget QAOA, aer_noisy, trust_region @ 00000000, 98 physical gates): best validated `10001000` loss 1.4093.

**Outcome:** best validated `10001100` loss 1.1316 — rank 2/256 (global minimum `11100011` 0.8801); inside the noise-consistent set (3 states); 40 forward simulations vs 256 exhaustive. Verdicts: {'improved': 1, 'regressed': 2, 'untested': 1, 'unchanged': 1}; new best found in iterations [1].

| # | verdict (basis) | best before → after | rank | sims | revised run | change |
|---|---|---|---|---|---|---|
| 1 | improved (model_specified) | 1.4093 → 1.1316 | 2 | 16 | aer_noisy · trust_region · 101 gates | Updated baseline of trust_region (trust_weight=0.15) from 00000000 to 10001000 while keeping provider=aer_noisy, shots=1024, and spec (reps=1, max_couplings=6,  |
| 2 | regressed (model_specified) | 1.1316 → 1.1316 | 2 | 24 | aer_noisy · trust_region · 81 gates · custom QASM | Re-centred trust_region (trust_weight=0.15) at 10001100 and replaced the swap-inducing 6-coupling QAOA spec with a heavy-hex-native 5-RZZ tree QASM circuit (cou |
| 3 | untested (experiment_best) | 1.1316 → 1.1316 | 2 | 24 | — |  |
| 4 | regressed (model_specified) | 1.1316 → 1.1316 | 2 | 32 | aer_noisy · trust_region · 60 gates · custom QASM | Replaced the q2,q3-uncoupled 5-RZZ tree circuit ([1,7], [0,1], [1,5], [4,5], [6,7]) of job 0a00b47c07ed4a74875a with a zero-SWAP 5-RZZ tree QASM circuit on coup |
| 5 | unchanged (same_provider) | 1.1316 → 1.1316 | 2 | 40 | aer_noisy · surrogate · 78 gates · custom QASM |  |

## Revisions

### Iteration 1 — improved

- **Observation:** Reference job 14db7cff685c45378160 (aer_noisy, 1024 shots, trust_region with baseline=00000000, trust_weight=0.15, reps=1, max_couplings=6) validated 8 states and found best bitstring 10001000 with nonlinear loss 1.4093, while 00000000 had loss 13.0803.
- **Diagnosis:** The QUBO linearised around 00000000 had poor fidelity over the validated region (Spearman 0.2857 vs simulated losses, ranking 10001000 4th and placing its argmin at 10000000 with loss 3.5466). Re-linearising trust_region around 10001000 increases Spearman correlation to 0.8095 and shifts ideal probability mass onto unsimulated neighbours 11001100 (p=0.1176) and 10001100 (p=0.0887) within a 101-gate physical circuit (16 two-qubit gates, depth 14).
- **Change:** Updated baseline of trust_region (trust_weight=0.15) from 00000000 to 10001000 while keeping provider=aer_noisy, shots=1024, and spec (reps=1, max_couplings=6, coupling_order=strength, optimization_level=3, warm_epsilon=0.25) unchanged.
- **Rationale:** Moving the trust-region linearisation point to the best validated hypothesis 10001000 improves local quadratic accuracy while testing a single controlled change on the same backend and shot budget.
- **Next step:** Re-centre the approximation at the new best validated bitstring 10001100 (loss 1.1316) and evaluate whether adjusting coupling selection, warm-start biasing, or trust_weight around 10001100 exposes lower-loss unsimulated states on qubits 2, 3, and 6 (which had zero two-qubit couplings in max_couplings=6).
- Tools: inspect_state → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → compile_circuit → run_experiment → build_problem → build_problem → build_problem → record_revision

### Iteration 2 — regressed

- **Observation:** In reference job 56f402e27c3a451eaa62 (aer_noisy, shots=1024, trust_region at baseline 10001000), the circuit found 10001100 (loss 1.1316) and completed validation of all 8 states in the 1x00xx00 subspace. Re-compiling the same spec at baseline 10001100 left all 8 top ideal states already simulated and mass_on_unsimulated_among_top16 = 0.0472. Our revised heavy-hex-native circuit (job 0a00b47c07ed4a74875a) reduced physical gates from 101 to 81 (CZ gates from 16 to 10, 2Q depth from 14 to 8, TVD vs ideal from 0.1378 to 0.1084), increased mass_on_unsimulated_among_top16 to 0.4277, ranked 10001100 #1 in noisy sampling (~30% of shots), and validated 8 new states around 10001100 led by 01001100 (loss 5.8841, 79 samples) and 10011100 (loss 9.0441, 75 samples).
- **Diagnosis:** Compiling the standard max_couplings=6 spec at baseline 10001100 showed two critical failures: (1) all 8 top ideal states (total probability 0.7149) were the already-simulated 1x00xx00 subspace, leaving mass_on_unsimulated_among_top16 at only 0.0472; (2) pruning J[5,6]=-1.8259 and J[6,7]=+1.1579 without mean-field compensation inverted the effective local field on q6 from -0.5316 (favouring q6=0, 10001100) to +2.4522 (favouring q6=1, 11001100), while uncompensated bare fields on q0,q1,q4,q5,q7 dwarfed h[2]=2.8123 and h[3]=5.3049, and the two coupling triangles [0,1,7] and [1,4,5] required SWAP routing (16 CZ gates, 99–101 physical gates).
- **Change:** Re-centred trust_region (trust_weight=0.15) at 10001100 and replaced the swap-inducing 6-coupling QAOA spec with a heavy-hex-native 5-RZZ tree QASM circuit (couplings [1,7], [0,1], [1,5], [4,5], [6,7] with mean-field-compensated RZ angles at 10001100) on aer_noisy (shots=1024).
- **Rationale:** Replacing the cyclic 6-coupling subgraph with the 5-edge heavy-hex-native tree ([1,7], [0,1], [1,5], [4,5], [6,7]) eliminates SWAP gates (10 CZ gates total) and couples q6 to q7 so tau=16 ms (01001100) is sampled alongside tau=30 ms (10001100), while mean-field-compensated RZ angles restore the correct local field sign on q6 and balance q2,q3 against q0,q1,q4,q5,q7 so probability concentrates on unsimulated neighbours of 10001100.
- **Next step:** With all 8 Hamming-1 neighbours of 10001100 now validated and confirming 10001100 (loss 1.1316) is a strict local minimum along every single-bit and single-parameter axis, use the 24-point surrogate (Spearman 0.9704) or trust_region at 10001100 to target unsimulated diagonal parameter trade-offs (such as 01001000, 01000100, 10011000, and 10010100 where inhibitory_gain c2 co-varies with synaptic_tau_ms or recurrent_excitation c1).
- Tools: inspect_state → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → build_problem → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → run_experiment → build_problem → build_problem → compile_circuit → record_revision

### Iteration 3 — untested

- **Observation:** (model ended without recording a revision)
- **Diagnosis:** 
- **Change:** 
- **Rationale:** 
- **Next step:** 
- Tools: inspect_state → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → inspect_state → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → build_problem → build_problem → build_problem → build_problem → compile_circuit → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → build_problem → inspect_state → build_problem → build_problem → compile_circuit → compile_circuit

### Iteration 4 — regressed

- **Observation:** At baseline 10001100 (loss 1.1316, 24/256 forward simulations used), standard QAOA on trust_region (trust_weight=0.15, max_couplings=6) puts 100% of its top-8 ideal probability on the already-simulated 1x00xx00 subspace (mass_on_unsimulated_among_top16 = 0.0325), while prior job 0a00b47c07ed4a74875a (81 physical gates, 10 CZ, depth 8) sampled only q3q2=11 states (best newly validated 01001100, loss 5.8841). Compiling our 5-RZZ tree on [6,7], [4,7], [2,7], [2,3], [0,3] reduced the physical circuit on fake_torino to 60 gates (9 CZ gates, two-qubit depth 9) and increased mass_on_unsimulated_among_top16 to 0.9490 (87.04% ideal mass in the top 8 unsimulated states). Executing on aer_noisy (job adb38b08d74441c287fc, shots=1024, TVD vs ideal 0.1132) validated 8 new states led by 01001000 (151 samples, loss 6.5030) and 01000100 (90 samples, loss 7.2403).
- **Diagnosis:** In job 0a00b47c07ed4a74875a, qubits q2 and q3 (inhibitory_gain c2) had zero two-qubit couplings and were locked to q3q2=11 (c2=3), so all 8 validated states stayed on the c2=3 slice (best newly validated loss 5.8841 at 01001100) while leaving the diagonal trade-off states on (tau, c2) and (c1, c2) unsimulated. Meanwhile, the unpruned and max_couplings=6 specs at baseline 10001100 place all 8 top ideal states inside the already-simulated 1x00xx00 subspace (mass_on_unsimulated_among_top16 = 0.0325–0.0366).
- **Change:** Replaced the q2,q3-uncoupled 5-RZZ tree circuit ([1,7], [0,1], [1,5], [4,5], [6,7]) of job 0a00b47c07ed4a74875a with a zero-SWAP 5-RZZ tree QASM circuit on couplings [6,7], [4,7], [2,7], [2,3], [0,3] under trust_region (baseline=10001100, trust_weight=0.15) on aer_noisy (shots=1024).
- **Rationale:** Coupling q2 and q3 via [2,3] and [2,7] along with [6,7], [4,7], and [0,3] embeds without SWAPs on fake_torino (degree <= 3 tree, 9 CZ gates vs 10 CZ and 60 vs 81 total physical gates) while suppressing the already-simulated q3q2=11 and 1x00xx00 subspaces, directly testing the unsimulated intermediate-inhibition hypotheses 01001000, 01000100, 10011000, 10010100, and 10010000.
- **Next step:** With all 12 states of the (tau in {1,2,3}, c1=0, c2 in {0,1,2,3}, P=0) grid and all 4 states of (tau=2, c1=1, c2 in {0,1,2,3}, P=0) now validated—confirming 10001100 (loss 1.1316) is the strict minimum across both subspaces—use the 32-point surrogate (Spearman 0.9703) or secant at 10001101/11001001 to test the remaining low-loss unsimulated states in the P=1 and tau=3 subspaces (10000101, 10000001, 11000101, 11000001, 11010000, and 00000100).
- Tools: inspect_state → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → run_experiment → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → inspect_state → record_revision

### Iteration 5 — unchanged

- **Observation:** (model ended without recording a revision)
- **Diagnosis:** 
- **Change:** 
- **Rationale:** 
- **Next step:** 
- Tools: inspect_state → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → build_problem → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → compile_circuit → run_experiment → build_problem

Verdicts are computed by the evaluator (new best validated hypothesis, else sample-distribution quality on equal footing), never taken from the model. 256 hypotheses are classically enumerable; this documents the agent's engineering loop, not quantum advantage.

Regenerate: `python research/experiments/campaign.py --preset ictal` (2138 s).
