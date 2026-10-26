# QuantumNeuroXAI (Sci. Rep. 2026): notes and how My Little Brain relates

## Citation

Gayathri, T., Manjula, G., Kenchannavar, H. H., Sudha, D., Jankatti, S. K., Kaur, R. & Venkateswarlu, B.
**"QuantumNeuroXAI: a quantum-inspired deep learning framework with explainability for brain signal analysis and neurological disorder detection."**
*Scientific Reports* **16**, 16863 (2026). https://doi.org/10.1038/s41598-026-47627-y
(Received 10 Jan 2026; accepted 1 Apr 2026; open access. Code: github.com/venkateshwarlu-bondu/QuantumNeuroXAI, Zenodo doi:10.5281/zenodo.19200650)

Rendered pages: `pages/page-01.png` … `pages/page-39.png` (150 dpi, 1240×1630 px). Video highlight boxes: `highlights.json`.

## Six-line summary

1. Deep-learning EEG classifiers are accurate, but they are black boxes, they are fragile under dataset shift, and they are hard to trust in a clinic.
2. QuantumNeuroXAI encodes EEG time-frequency features with "quantum-inspired" amplitude/phase encoding and a parameterised feature map, all simulated deterministically on classical hardware.
3. Those features go into a temporal-CNN plus attention-RNN with a quantum–classical fusion layer.
4. Explanations come at three levels: signal (channels, time, frequency bands), model (attention, attribution) and quantum-representation (feature sensitivity).
5. On TUH EEG, CHB-MIT and BCI IV-2a, macro-F1 beats classical, deep and quantum-kernel baselines by up to 5.2% (for CHB-MIT: Acc/F1/AUROC 0.975/0.971/0.994).
6. The authors state that no quantum hardware is used. They name real-time explanation cost, hyperparameter tuning, controlled datasets and the lack of clinician-in-the-loop validation as limitations.

## Problem / method / results

- **Problem:** supervised classification of EEG segments (normal vs abnormal, seizure vs non-seizure, 4-class motor imagery) in a way that is accurate, robust and interpretable.
- **Method:** preprocessing (artifact suppression, windowing, time-frequency transform), then a quantum-inspired encoding Φ (amplitude/phase), a parameterised map Q_θ and a measurement M (all classical simulation), then TCN + attention-RNN + fusion, then XAI (signal/model/quantum levels). The model is trained offline with cross-entropy on subject-independent splits.
- **Results:** best in-dataset Acc/F1/AUROC on all three datasets (Table 4). Ablations show the quantum-inspired encoding, attention and fusion each contribute. Statistical tests over 5 runs show medium-to-large effect sizes. Explanations line up with physiologically plausible channels and bands. Explanations take under a second after a decision, while training is offline.
- **Caveat seen while reading:** the contributions paragraph says "Across five public datasets", but the paper evaluates three.

## How My Little Brain extends this frontier

Each claim below is scoped to what we actually built and measured. We do not claim quantum advantage.

1. **We run real quantum hardware, where they simulate quantum-inspired math.** QuantumNeuroXAI states that it "does not rely on quantum hardware" and lists "high-quality quantum hardware" as future work. We compile the same problem into QAOA circuits and execute them on IonQ (all-to-all, 52 gates for the full problem) and IBM heavy-hex (454 gates before pruning), via qBraid across several vendors. We also run Extropic's THRML thermodynamic sampler. We report the hardware cost honestly: on an equal budget, surrogate plus noisy QAOA found the target in 5/11 runs vs 3/11 for random search, which is within noise.
2. **We infer mechanisms where they classify labels.** They learn a black-box mapping f_θ: EEG → label and explain it afterwards. We solve an inverse problem: which Wilson–Cowan neural-mass parameters (drive P, recurrent excitation c1, inhibitory gain c2, synaptic time constant τ) reproduce the observed 10-band relative spectrum? The answer is itself the explanation, in physiological units. On the same CHB-MIT corpus they use (chb01_03), our seizure windows moved τ from about 16 ms to 30–55 ms (slower synaptic dynamics), and channels split into two dynamical regimes. This is an n-of-1 observation, not a validated biomarker.
3. **Our loop is agentic and closed, where theirs is a fixed offline pipeline.** Their model needs a fixed architecture, per-task hyperparameter tuning ("limits their use in an out-of-the-box fashion") and offline training. Our Gemini agent picks channels and windows by looking at spectrograms, builds QUBO surrogates of the nonlinear loss (ridge/BOCS-style, trust-region, secant, Jacobian), writes and revises its own QAOA circuits (including OpenQASM; one custom circuit had 42 gates), and checks every top sample by forward simulation. Working blind on synthetic data, it recovered the hidden parameters with 48 of 256 possible simulations in 2–3 iterations.
4. **We work on personal, everyday EEG, where they use curated clinical archives.** Their own limitation is that public datasets "do not necessarily reflect the variability encountered in day-to-day clinical practice." We stream an OpenBCI Cyton straight into Chrome over Web Serial, with no bridge or install, and combine it with the user's notes. This makes it an individual's own consumer-grade EEG analysed while they wait, rather than a fixed cohort.
5. **Our explanations can be checked, where theirs are attributions.** Their XAI produces relevance maps over channels, time and bands. Our output is a small hypothesis (8 bits, 256 candidates) whose predicted spectrum can be regenerated and compared against the data. Every claim our agent makes comes with a forward-simulation check, not just a heatmap.

### Limits (stated plainly)

- We do not classify disorders and report no accuracy, F1 or AUROC. The two systems answer different questions, so neither one beats the other.
- The 8-qubit, 2-bit-per-parameter grid is coarse. A classical exhaustive search over 256 candidates is trivial, so the quantum step is a demonstration of the workflow, not a speedup.
- The benchmark (5/11 vs 3/11) is small and not statistically significant. Hardware noise and gate depth (IBM's 454 gates) limit fidelity.
- Wilson–Cowan with 10 relative band powers is a simplified forward model. Its parameters are partly non-identifiable, and the CHB-MIT finding comes from a single recording.
- This is not a medical device. Nothing here has had clinician validation, which is the same gap QuantumNeuroXAI acknowledges.
