// copilotTurn.js — pure reducer folding a streaming agent turn's SSE typed events into a
// render-ready trace. Side-effect-free by design: viewer co-navigation (client tools) and
// artifact fetches (server tools) are the panel's job, keyed off the same events. The event
// shapes mirror the backend's typed-event family (run_started / reasoning_delta /
// tool_call_start / tool_call_result / text_delta / run_finished / run_error).

// A fresh, empty turn trace. `needsApproval` flips true when a server tool is gate-denied,
// so the panel can offer an approved re-run of the same message.
export function initTrace() {
  return {
    runId: null,
    status: 'running',   // 'running' | 'done' | 'error' | 'stopped'
    reasoning: '',
    text: '',
    steps: [],           // [{ id, name, toolClass, args, status, summary, artifact, gated }]
    error: null,
    needsApproval: false,
  };
}

// True when a failed tool result is a permission-gate denial (vs. a genuine tool failure),
// so the panel shows "Approve & run" instead of a plain error.
export function isGateDenial(summary) {
  return typeof summary === 'string' && /\bapprov(e|al)\b/i.test(summary);
}

// reduceTurnEvent(trace, evt) -> next trace. Immutable: never mutates its input.
export function reduceTurnEvent(trace, evt) {
  switch (evt.type) {
    case 'run_started':
      return { ...initTrace(), runId: evt.run_id };

    case 'reasoning_delta':
      return { ...trace, reasoning: trace.reasoning + (evt.text || '') };

    case 'text_delta':
      return { ...trace, text: trace.text + (evt.text || '') };

    case 'tool_call_start':
      return {
        ...trace,
        steps: [
          ...trace.steps,
          {
            id: evt.tool_call_id,
            name: evt.name,
            toolClass: evt.tool_class || 'server',
            args: evt.args || {},
            status: 'running',
            summary: '',
            artifact: null,
            gated: false,
          },
        ],
      };

    case 'tool_call_result': {
      const gated = !evt.ok && isGateDenial(evt.summary);
      const steps = trace.steps.map((s) =>
        s.id === evt.tool_call_id
          ? { ...s, status: evt.ok ? 'ok' : 'error', summary: evt.summary || '',
              artifact: evt.artifact || null, gated }
          : s);
      return { ...trace, steps, needsApproval: trace.needsApproval || gated };
    }

    case 'run_finished':
      return { ...trace, status: 'done', text: evt.text || trace.text };

    case 'run_error':
      return { ...trace, status: 'error', error: evt.message || 'The agent run failed.' };

    // The user aborted the in-flight turn. Terminal, but not an error: the partial trace
    // (reasoning, tool cards, any streamed text) is kept as-is so the stop is legible.
    case 'run_stopped':
      return { ...trace, status: 'stopped' };

    default:
      return trace;
  }
}
