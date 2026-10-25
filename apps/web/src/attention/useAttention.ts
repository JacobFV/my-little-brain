import { useEffect, useRef, useState } from 'react';
import { advanceEnergy, distractionFor } from './energy';
const KEY = 'little-brain.attention.v1';
function read(): Record<string, number> {
  try {
    const values = JSON.parse(localStorage.getItem(KEY) || '{}');
    return Object.fromEntries(
      Object.entries(values).filter(
        ([id, value]) =>
          id.length <= 100 &&
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 1,
      ),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}
export function useAttention(
  id: string,
  working: boolean,
  seeing: boolean,
  resting: boolean,
  ready = true,
  workingIds: string[] = [],
  twinIds: string[] = [id],
) {
  const [energies, setEnergies] = useState<Record<string, number>>({});
  useEffect(() => {
    const refresh = () => {
      if (ready) setEnergies(read());
    };
    refresh();
    window.addEventListener('little-brain.local-data-restored', refresh);
    return () => window.removeEventListener('little-brain.local-data-restored', refresh);
  }, [ready]);
  const input = useRef({ id, working, seeing, resting, ready, workingIds, twinIds });
  input.current = { id, working, seeing, resting, ready, workingIds, twinIds };
  useEffect(() => {
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now(),
        seconds = (now - last) / 1000;
      last = now;
      const current = input.current;
      if (!current.ready) return;
      setEnergies((values) =>
        Object.fromEntries(
          current.twinIds.map((twinId) => [
            twinId,
            advanceEnergy(
              values[twinId] ?? 0.85,
              seconds,
              (twinId === current.id && current.working) || current.workingIds.includes(twinId),
              twinId === current.id && current.seeing,
              twinId === current.id && current.resting,
            ),
          ]),
        ),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  const latest = useRef(energies);
  latest.current = energies;
  useEffect(() => {
    const save = () => {
      if (!input.current.ready) return;
      try {
        localStorage.setItem(KEY, JSON.stringify(latest.current));
        window.dispatchEvent(new Event('little-brain.local-data-changed'));
      } catch {}
    };
    const timer = setInterval(save, 10000);
    window.addEventListener('pagehide', save);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', save);
      save();
    };
  }, []);
  const energy = energies[id] ?? 0.85;
  return { energy, distraction: resting ? null : distractionFor(energy) };
}
