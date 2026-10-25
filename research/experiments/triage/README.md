# Gemini EEG triage → quantum splintering (CHB-MIT chb01_03)

Gemini 4 Argon rendered per-channel spectrograms (`chbmit_chb01_03_spectrograms.png`), looked at them and
picked channels/windows with stated reasons, then each pick became its own 8-qubit inverse problem.

| pick (chosen from spectrograms) | best hypothesis | P | c2 | c1 | τ |
|---|---|---|---|---|---|
| FT9-FT10 · pre-ictal 2960–2996 s | 01100011 | 3.0 | 10 | 16 | 16 ms |
| FT9-FT10 · ictal 2996–3036 s | 10001100 | 1.5 | 19 | 12 | 30 ms |
| P8-O2 · ictal | 11001100 | 1.5 | 19 | 12 | 55 ms |
| T8-P8 · ictal | 11100011 | 3.0 | 10 | 16 | 55 ms |

All ictal windows require slower synaptic dynamics (τ 16 → 30–55 ms); channels split into a high-drive /
weak-inhibition regime (T8-P8) and a low-drive / strong-inhibition regime (P8-O2, FT9-FT10); no consistent
hypothesis is shared across picks. Best hypotheses above are exact (classical enumeration reference); a single
round of full unpruned QAOA on the IonQ simulator (52 gates, all-to-all) does not reach them on its own — the
agent's design iterations close that gap. Model hypotheses of a simplified neural mass, not seizure causes.
Full record: `chbmit_chb01_03.json`.
