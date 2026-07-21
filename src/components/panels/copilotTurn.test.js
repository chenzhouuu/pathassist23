// Pure reducer for a streaming agent turn: SSE typed events → a render-ready trace.
// The heart of the /turns cut-over; kept side-effect-free so it is unit-testable. Viewer
// co-navigation and artifact fetches are the component's job, keyed off the same events.
import { describe, it, expect } from 'vitest';
import { initTrace, reduceTurnEvent, isGateDenial } from './copilotTurn.js';

// Replay a whole event stream through the reducer, as the panel does live.
const run = (events) => events.reduce(reduceTurnEvent, initTrace());

describe('reduceTurnEvent', () => {
  it('opens a running trace on run_started', () => {
    const t = reduceTurnEvent(initTrace(), { type: 'run_started', run_id: 'r1' });
    expect(t).toMatchObject({ runId: 'r1', status: 'running', steps: [], text: '', reasoning: '' });
  });

  it('accumulates reasoning and answer deltas', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'reasoning_delta', text: 'Let me ' },
      { type: 'reasoning_delta', text: 'segment it.' },
      { type: 'text_delta', text: 'There are ' },
      { type: 'text_delta', text: '1,234 nuclei.' },
    ]);
    expect(t.reasoning).toBe('Let me segment it.');
    expect(t.text).toBe('There are 1,234 nuclei.');
  });

  it('adds a tool card on start and resolves it by tool_call_id', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'tool_call_start', tool_call_id: 'c1', name: 'pan_zoom_to_region',
        tool_class: 'client', args: { bbox: { x: 0, y: 0, width: 8, height: 8 } } },
      { type: 'tool_call_result', tool_call_id: 'c1', ok: true, summary: 'framed the region' },
    ]);
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0]).toMatchObject({
      id: 'c1', name: 'pan_zoom_to_region', toolClass: 'client',
      status: 'ok', summary: 'framed the region',
    });
  });

  it('lifts a server tool artifact handle onto its card', () => {
    const handle = { kind: 'nuclei', ref: 'abc', count: 1234 };
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'tool_call_start', tool_call_id: 's1', name: 'run_segmentation', tool_class: 'server' },
      { type: 'tool_call_result', tool_call_id: 's1', ok: true,
        summary: 'segmented 1,234 nuclei', artifact: handle },
    ]);
    expect(t.steps[0].artifact).toEqual(handle);
    expect(t.steps[0].status).toBe('ok');
  });

  it('flags a gate denial for approval so the panel can offer a re-run', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'tool_call_start', tool_call_id: 's1', name: 'run_segmentation', tool_class: 'server' },
      { type: 'tool_call_result', tool_call_id: 's1', ok: false,
        summary: 'Running run_segmentation needs your approval — it is a server-side analysis tool.' },
    ]);
    expect(t.steps[0].status).toBe('error');
    expect(t.steps[0].gated).toBe(true);
    expect(t.needsApproval).toBe(true);
  });

  it('does not flag a plain tool error as needing approval', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'tool_call_start', tool_call_id: 's1', name: 'run_segmentation', tool_class: 'server' },
      { type: 'tool_call_result', tool_call_id: 's1', ok: false, summary: 'the tool crashed' },
    ]);
    expect(t.steps[0].status).toBe('error');
    expect(t.steps[0].gated).toBeFalsy();
    expect(t.needsApproval).toBe(false);
  });

  it('finishes with the run_finished text as the authoritative answer', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'text_delta', text: 'streamed partial' },
      { type: 'run_finished', text: 'Final answer — 1,234 nuclei.' },
    ]);
    expect(t.status).toBe('done');
    expect(t.text).toBe('Final answer — 1,234 nuclei.');
  });

  it('keeps the streamed text if run_finished carries none', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'text_delta', text: 'kept answer' },
      { type: 'run_finished', text: '' },
    ]);
    expect(t.text).toBe('kept answer');
  });

  it('captures a run_error terminal state', () => {
    const t = run([
      { type: 'run_started', run_id: 'r1' },
      { type: 'run_error', message: 'The agent loop failed (RuntimeError).' },
    ]);
    expect(t.status).toBe('error');
    expect(t.error).toBe('The agent loop failed (RuntimeError).');
  });
});

describe('isGateDenial', () => {
  it('recognizes the backend approval reason', () => {
    expect(isGateDenial('Running run_segmentation needs your approval — it is server-side.')).toBe(true);
  });
  it('is false for other messages', () => {
    expect(isGateDenial('segmented 1,234 nuclei')).toBe(false);
    expect(isGateDenial('')).toBe(false);
    expect(isGateDenial(null)).toBe(false);
  });
});
