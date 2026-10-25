import { useState } from 'react';
import { ArrowRight, Brain, Download, Pause, Play, Trash2, Users } from 'lucide-react';
import type { Twin } from '@little-brain/core';
import type { BackgroundHandle } from './useBackgroundBrains';
import type { BackgroundJob } from './jobs';
import './background.css';
function exportJob(job: BackgroundJob) {
  const text = `${job.topic}\n${job.participants.map((p) => p.name).join(' + ')} · ${job.status}\n\n${job.transcript.map((t) => `${t.name}${t.unfinished ? ' (unfinished)' : ''}\n${t.text}`).join('\n\n')}${job.draft?.text ? `\n\n${job.draft.name} (unfinished)\n${job.draft.text}` : ''}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `brain-work-${job.id.slice(0, 8)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function BackgroundPanel({
  background,
  twins,
}: {
  background: BackgroundHandle;
  twins: Twin[];
}) {
  const [topic, setTopic] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => twins.slice(0, 2).map((t) => t.id));
  const selected = chosen.filter((id) => twins.some((t) => t.id === id));
  return (
    <section className="background-panel" aria-label="Background brain work">
      <div className="background-heading">
        <span className="background-symbol">
          <Users size={21} />
        </span>
        <div>
          <h2>A little room to collaborate.</h2>
          <p>Give one or two brains a topic to think through together.</p>
        </div>
      </div>
      <form
        className="background-form"
        onSubmit={(e) => {
          e.preventDefault();
          background.start({ topic, twinIds: selected });
        }}
      >
        <label className="background-topic">
          What should they work on?
          <textarea
            aria-label="Background work topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Explore a small weekend project, compare ideas, or make a plan…"
            required
            disabled={!!background.activeJobId}
          />
        </label>
        <div
          className="background-participants"
          role="group"
          aria-label="Choose collaborating brains"
        >
          {twins.map((t) => (
            <label key={t.id} className={selected.includes(t.id) ? 'selected' : ''}>
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                disabled={
                  !!background.activeJobId || (!selected.includes(t.id) && selected.length >= 2)
                }
                onChange={() =>
                  setChosen(
                    selected.includes(t.id)
                      ? selected.filter((id) => id !== t.id)
                      : [...selected, t.id],
                  )
                }
              />
              <Brain size={15} />
              {t.name}
            </label>
          ))}
        </div>
        <div className="background-start-row">
          <span>Continues until you stop it</span>
          {background.activeJobId ? (
            <button type="button" className="background-stop" onClick={background.stop}>
              <Pause size={14} />
              Stop work
            </button>
          ) : (
            <button type="submit" disabled={!topic.trim() || !selected.length}>
              Start work <ArrowRight size={14} />
            </button>
          )}
        </div>
      </form>
      <p className="background-boundary">
        Uses your OpenAI connection. Brains keep taking turns until you stop them. Work continues as
        you explore the app; closing it stops work, and your device may suspend background tabs.
        Resume unfinished jobs yourself. Only notes are created.
      </p>
      {(background.error || background.storageError) && (
        <p className="background-error" role="alert">
          {background.error || background.storageError}
        </p>
      )}
      <div className="background-jobs">
        {background.jobs.map((job, index) => (
          <details
            className="background-job"
            key={job.id}
            open={job.id === background.activeJobId || index === 0 ? true : undefined}
          >
            <summary>
              <span>
                <strong>{job.topic}</strong>
                <small>
                  {job.participants.map((p) => p.name).join(' + ')} · {job.transcript.length} turns
                </small>
              </span>
              <span className={`job-status ${job.status}`}>
                {job.status === 'running'
                  ? 'Working'
                  : job.status === 'complete'
                    ? 'Finished'
                    : job.status === 'failed'
                      ? 'Needs attention'
                      : 'Paused'}
              </span>
            </summary>
            <div className="background-transcript">
              {job.transcript.map((turn) => (
                <article key={turn.id}>
                  <h3>
                    {turn.name}
                    {turn.unfinished && <span>unfinished</span>}
                  </h3>
                  <p>{turn.text}</p>
                </article>
              ))}
              {job.draft && (
                <article className="background-draft">
                  <h3>
                    {job.draft.name}
                    <span>{job.status === 'running' ? 'thinking…' : 'unfinished'}</span>
                  </h3>
                  <p>
                    {job.draft.text ||
                      (job.status === 'running'
                        ? 'Connecting and forming a thought…'
                        : 'No completed reply yet.')}
                  </p>
                </article>
              )}
              {job.error && (
                <p className="background-error" role="alert">
                  {job.error}
                </p>
              )}
              <div className="background-job-actions">
                {job.status !== 'running' && job.status !== 'complete' && (
                  <button
                    type="button"
                    disabled={!!background.activeJobId}
                    onClick={() => background.resume(job.id)}
                  >
                    <Play size={13} />
                    Resume
                  </button>
                )}
                <button type="button" onClick={() => exportJob(job)}>
                  <Download size={13} />
                  Export notes
                </button>
                <button
                  type="button"
                  disabled={job.id === background.activeJobId}
                  onClick={() => background.remove(job.id)}
                  aria-label={`Delete background job ${job.topic}`}
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
