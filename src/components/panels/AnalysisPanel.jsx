// src/components/panels/AnalysisPanel.jsx
// The algorithm catalog (Inc 6 · 02). Every tool in it is a native PathAssist tool declared as data
// in `analysis/nativeCatalog.js`, and clicking one opens a form built from that declaration.
//
// It used to be two sources. HistomicsTK docker CLIs described their form in Slicer XML, which
// `parseXml.js` turned into the same `{title, description, groups}` shape, so everything downstream
// was shared and only the two producers differed. That half went on 2026-08-03 — see
// docs/docker-cli-technical-report.md. What survives it is the shape: `nativeCatalog` still speaks
// the Slicer parameter vocabulary, because `ParamField` renders it and a second vocabulary would
// buy nothing.
//
// The old `running` view is gone. A submitted job is not a modal state: the panel returns to the
// list, and the Runs section beneath the catalog (03) is where every run — this slide's, other
// slides', other users' — is watched.
//
// Entries submit to their own gateway endpoints, and every one of them is a Girder job on one
// queue (05 → 07). All five task panels are gone, so this is the only place any analysis can be
// started — and a submission can be several runs: a feature index is three steps and a task on a
// bare slide is four, planned server-side and drawn in Runs as one thing.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../../store/index.js';
import { listArtifacts } from '../../api/preprocessApi.js';
import ParamField from './analysis/ParamField.jsx';
import RunsSection from './analysis/RunsSection.jsx';
import {
  NATIVE_GROUP, NATIVE_TOOLS, describePlan, firstProblem, isEnabled, seedValues, toolParams,
} from './analysis/nativeCatalog.js';
import { useRegionSelect } from './useRegionSelect.js';

// ── Main AnalysisPanel ────────────────────────────────────────────────────────
export default function AnalysisPanel() {
  const { activeItem } = useStore();
  const qc = useQueryClient();
  const region = useRegionSelect();

  // ── State machine: list | form ────────────────────────────────────────────
  const [view, setView] = useState('list');
  const [selected, setSelected] = useState(null);   // the catalog entry that was clicked
  const [meta, setMeta] = useState(null);           // { title, description, groups }
  const [formValues, setFormValues] = useState({});
  const [loadingForm, setLoadingForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(null); // { title } — the last thing sent
  const [plan, setPlan] = useState(null);           // the server's answer to "what would this cost"
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');

  // ── This slide's artifacts — what the upstream pickers choose from ────────
  const { data: artifacts, isLoading: loadingArtifacts } = useQuery({
    queryKey: ['artifacts', activeItem?._id],
    queryFn: () => listArtifacts(activeItem._id),
    enabled: !!activeItem?._id && view === 'form',
    retry: 1,
  });

  // ── The catalog ───────────────────────────────────────────────────────────
  // One group, one producer. The docker half — sixty lines that flattened four different shapes of
  // `GET /slicer_cli_web/docker_image` into a CLI list — went on 2026-08-03 with the CLIs.
  const entries = useMemo(() => (
    NATIVE_TOOLS.map(t => ({ source: 'native', group: NATIVE_GROUP, name: t.id, title: t.title, tool: t }))
  ), []);

  const groupKeys = useMemo(() => [NATIVE_GROUP], []);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const hit = (e) => !q
      || (e.title || '').toLowerCase().includes(q)
      || (e.name || '').toLowerCase().includes(q);
    return groupKeys
      .filter(k => groupFilter === 'all' || k === groupFilter)
      .map(k => [k, entries.filter(e => e.group === k && hit(e))])
      .filter(([, es]) => es.length > 0);
  }, [entries, groupKeys, search, groupFilter]);

  const shownCount = useMemo(
    () => filteredGroups.reduce((sum, [, es]) => sum + es.length, 0),
    [filteredGroups],
  );

  // ── Open an entry: read its declaration ───────────────────────────────────
  const openEntry = useCallback(async (entry) => {
    setSelected(entry);
    setError('');
    setSubmitted(null);
    setView('form');

    const tool = entry.tool;
    setMeta(tool);
    setFormValues(seedValues(tool));
    // Options that only the service can answer (which tissue backends are deployed, which task
    // heads are trained) are resolved now, so the form never offers something that is not there.
    const dynamic = toolParams(tool).filter(p => p.optionsFrom);
    if (dynamic.length === 0) return;
    setLoadingForm(true);
    try {
      const resolved = await Promise.all(dynamic.map(async p => [p.name, await p.optionsFrom()]));
      setMeta({
        ...tool,
        groups: tool.groups.map(g => ({
          ...g,
          params: g.params.map(p => {
            const found = resolved.find(([n]) => n === p.name);
            return found ? { ...p, options: found[1] } : p;
          }),
        })),
      });
    } catch (e) {
      setError('Could not reach the service for this tool: ' + e.message);
    }
    setLoadingForm(false);
  }, []);

  // ── What this submission is about to cost ─────────────────────────────────
  // Asked of the server, not worked out here, and that is the point of 08: one planner answers
  // it, and it is the same function that will run the submission — so the sentence in front of
  // the button and what the button does cannot drift apart. A fourth client-side copy of the
  // dependency graph is what this replaces.
  useEffect(() => {
    if (!meta || !activeItem
        || firstProblem(meta, formValues, { roi: region.roi })) {
      setPlan(null);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      selected.tool.submit(activeItem._id, formValues, { roi: region.roi, mode: 'plan' })
        .then(p => { if (live) setPlan(p); })
        .catch(() => { if (live) setPlan(null); });
    }, 250);   // the form is a few selects; a keystroke should not be a round trip
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, activeItem?._id, formValues, region.roi]);

  const backToList = useCallback(() => {
    setView('list');
    setMeta(null);
    setSelected(null);
    setError('');
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  // `mode` is the user's answer to what the plan just told them: everything, or only the step that
  // can run without waiting. Neither is a default — a three-step submission at `concurrency=1` is
  // a wait somebody agrees to, and so is stopping after the first (Inc 6 · 08).
  const submit = useCallback(async (mode) => {
    if (!selected || !meta || !activeItem) return;
    setSubmitting(true);
    setError('');
    try {
      const ack = await selected.tool.submit(activeItem._id, formValues, { roi: region.roi, mode });
      qc.invalidateQueries({ queryKey: ['artifacts', activeItem._id] });
      // Do not wait out the poll interval to see what was just submitted.
      qc.invalidateQueries({ queryKey: ['pathassist-runs'] });
      // A content-addressed build whose every step already exists queues nothing, and saying
      // "submitted" would send someone to a Runs list with nothing new in it. The server answers
      // `status: 'ready'`; the banner repeats what it said.
      setSubmitted({
        title: meta.title || selected.title || selected.name,
        reused: ack?.status === 'ready' && Array.isArray(ack?.steps) && ack.steps.length === 0,
      });
      // A submitted job is not a modal state — back to the list, and it is watched in Runs.
      setView('list');
      setMeta(null);
      setSelected(null);
      setPlan(null);
    } catch (e) {
      setError('Submission failed: ' + (e?.response?.data?.message || e.message));
    }
    setSubmitting(false);
  }, [selected, meta, activeItem, formValues, region.roi, qc]);

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: LIST view
  // ──────────────────────────────────────────────────────────────────────────
  if (view === 'list') return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-2">

        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted-hex)', fontSize: 10 }}>
            Available Algorithms
          </span>
          {!activeItem && (
            <span className="text-xs" style={{ color: '#f5a623' }}>No slide open</span>
          )}
        </div>

        {submitted && (
          <div className="rounded p-2 mb-2 flex items-center gap-2" data-cy="submitted-banner"
            style={{ background: 'rgba(76,175,130,0.12)', border: '1px solid rgba(76,175,130,0.3)' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="text-xs flex-1" style={{ color: '#4caf82' }}>
              {submitted.reused
                ? `${submitted.title} — already built, nothing to run`
                : `${submitted.title} submitted`}
            </span>
            <button onClick={() => setSubmitted(null)} className="text-xs shrink-0"
              style={{ color: 'var(--muted-hex)' }}>✕</button>
          </div>
        )}

        <div className="mb-2 flex items-center gap-1.5">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter algorithms..."
            className="flex-1 rounded px-2 py-1 text-xs outline-none"
            style={{ background: 'var(--bg)', border: '1px solid var(--border-hex)', color: 'var(--text)' }}
            onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.45)'}
            onBlur={e => e.target.style.borderColor = 'var(--border-hex)'}
          />
          <select
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
            aria-label="Source"
            className="rounded px-2 py-1 text-xs outline-none"
            style={{ background: 'var(--bg)', border: '1px solid var(--border-hex)', color: 'var(--text)', minWidth: 100 }}
            onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.45)'}
            onBlur={e => e.target.style.borderColor = 'var(--border-hex)'}>
            <option value="all">All Sources</option>
            {groupKeys.map(key => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
        </div>

        <div className="mb-2 text-xs" style={{ color: 'var(--muted-hex)', fontSize: 10 }}>
          {shownCount} / {entries.length} algorithm{entries.length !== 1 ? 's' : ''}
        </div>

        {shownCount === 0 && (
          <div className="text-center py-4" style={{ color: 'var(--muted-hex)', fontSize: 11 }}>
            No algorithms match the current filter.
          </div>
        )}

        {filteredGroups.map(([groupKey, groupEntries]) => (
          <div key={groupKey} className="mb-3">
            <div className="font-mono truncate mb-1 px-1" style={{ color: 'var(--muted-hex)', fontSize: 9 }}
              title={groupKey}>{groupKey}</div>
            <div className="flex flex-col gap-0.5">
              {groupEntries.map(entry => (
                <button key={`${entry.source}:${entry.group}:${entry.name}`}
                  onClick={() => openEntry(entry)}
                  disabled={!activeItem}
                  data-cy="algorithm-row"
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-left transition-all group"
                  style={{ background: 'var(--highlight-hex)', border: '1px solid var(--border-hex)' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(77,166,255,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-hex)'}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="#4da6ff" stroke="none">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span className="flex-1 text-xs" style={{ color: 'var(--text)' }}>{entry.title}</span>
                  <span className="text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: '#4da6ff' }}>Run →</span>
                </button>
              ))}
            </div>
          </div>
        ))}

      </div>

      {/* Under the catalog, and pinned there. The catalog is nineteen rows deep, so a Runs
          section that simply followed it in the scroll would be the one part of this panel
          nobody ever saw — which is the problem the section exists to fix. */}
      <div className="shrink-0 px-2 pb-2 overflow-y-auto" style={{ maxHeight: '45%' }}>
        <RunsSection activeItem={activeItem} />
      </div>
    </div>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: FORM view
  // ──────────────────────────────────────────────────────────────────────────
  const problem = meta
    ? firstProblem(meta, formValues, { roi: region.roi })
    : null;
  const cost = describePlan(plan);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Form header */}
      <div className="flex items-center gap-2 px-2 py-1.5 shrink-0"
        style={{ borderBottom: '1px solid var(--border-hex)', background: 'var(--bg-toolbar)' }}>
        <button onClick={backToList}
          aria-label="Back to algorithms"
          className="p-0.5 rounded hover:bg-black/5 transition-colors"
          style={{ color: 'var(--muted-hex)' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text)' }}>
            {meta?.title || selected?.title || selected?.name}
          </div>
          <div style={{ color: 'var(--muted-hex)', fontSize: 9 }}>
            {meta?.category || NATIVE_GROUP}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loadingForm && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
            <div style={{ color: 'var(--muted-hex)', fontSize: 11 }}>Loading parameters…</div>
          </div>
        )}

        {error && (
          <div className="rounded p-2 mb-2 text-xs" style={{ background: 'rgba(233,69,96,0.1)', border: '1px solid rgba(233,69,96,0.3)', color: '#e94560' }}>
            {error}
          </div>
        )}

        {/* The CLI path had its own "draw a rectangle" banner here, because a Slicer `region` param
            is a text field the drawing fills in. A native tool's region is the `pa-region` field
            itself, which says so where the value goes. */}
        {meta && !loadingForm && (
          <>
            {/* Description */}
            {meta.description && (
              <div className="rounded-lg p-2.5 mb-3 text-xs leading-relaxed"
                style={{ background: 'var(--highlight-hex)', border: '1px solid var(--border-hex)', color: 'var(--muted-hex)' }}>
                {meta.description}
              </div>
            )}

            {/* Input slide card — mirrors DSA's "Input Image" field */}
            <div className="rounded-lg p-2.5 mb-3" style={{ background: 'var(--highlight-hex)', border: '1px solid var(--border-hex)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <span style={{ color: 'var(--muted-hex)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                  Input Image
                </span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded"
                style={{ background: 'var(--bg)', border: '1px solid var(--border-hex)' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-xs truncate font-medium" style={{ color: '#4da6ff', flex: 1 }}>
                  {activeItem?.name || '—'}
                </span>
                <span className="text-xs shrink-0" style={{ color: 'var(--muted-hex)' }}>
                  {activeItem?.size ? `${(activeItem.size / 1024 / 1024 / 1024).toFixed(2)} GB` : ''}
                </span>
              </div>
              <div className="mt-1.5" style={{ color: 'var(--muted-hex)', fontSize: 9 }}>
                Output → this slide’s artifacts, in Workspace
              </div>
            </div>

            {/* User-configurable parameters */}
            {meta.groups.map(group => {
              const userParams = group.params;
              if (userParams.length === 0) return null;
              return (
                <div key={group.label} className="mb-3">
                  {group.label && (
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex-1 h-px" style={{ background: 'var(--border-hex)' }} />
                      <span style={{ color: 'var(--muted-hex)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, flexShrink: 0 }}>
                        {group.label}
                      </span>
                      <div className="flex-1 h-px" style={{ background: 'var(--border-hex)' }} />
                    </div>
                  )}
                  <div className="flex flex-col gap-3">
                    {userParams.map(p => (
                      <ParamField key={p.name} param={p}
                        value={formValues[p.name] ?? p.defVal}
                        onChange={v => setFormValues(prev => ({
                          ...prev, [p.name]: v,
                          // A tool may declare that one field decides others — the encoder binds
                          // the tiling geometry (Fork B). Declared by the tool rather than
                          // hard-coded here: this renderer draws whatever is declared and has no
                          // business knowing what an encoder is.
                          ...(selected?.tool?.onChange?.(p.name, v, prev) || {}),
                        }))}
                        region={region}
                        artifacts={artifacts}
                        artifactsLoading={loadingArtifacts}
                        disabled={!isEnabled(p, formValues)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Submit bar */}
      {meta && !loadingForm && (
        <div className="shrink-0 px-2 py-2" style={{ borderTop: '1px solid var(--border-hex)' }}>
          {problem && (
            <div className="mb-2 text-xs" style={{ color: '#f5a623', fontSize: 10 }}>{problem}</div>
          )}

          {/* What this is about to do, before it does it (Inc 6 · 08). The steps are named rather
              than counted — "2 upstreams" is a number, and which two is the answer — and the
              queue-slot count is said out loud because at concurrency=1 it is a wait the user
              agrees to on everyone else's behalf as well as their own. */}
          {cost && !problem && (
            <div className="mb-2 rounded px-2 py-1.5" data-cy="submission-plan"
              style={{ background: 'var(--highlight-hex)', border: '1px solid var(--border-hex)' }}>
              <div style={{ color: cost.built ? '#4caf82' : '#4da6ff', fontSize: 10 }}>
                {cost.headline}
              </div>
              {cost.steps.length > 1 && (
                <ol className="mt-1 space-y-0.5" style={{ color: 'var(--muted-hex)', fontSize: 9 }}>
                  {cost.steps.map((step, i) => (
                    <li key={step.art_hash || step.kind}>{i + 1}. {step.title}</li>
                  ))}
                </ol>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={backToList}
              className="flex items-center justify-center px-3 py-2 rounded text-xs transition-all"
              style={{ background: 'var(--highlight-hex)', color: 'var(--muted-hex)', border: '1px solid var(--border-hex)' }}>
              Cancel
            </button>
            <button onClick={() => submit()} disabled={submitting || !activeItem || !!problem}
              data-cy="run-all"
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded font-semibold text-xs transition-all"
              style={{
                background: submitting || !activeItem || problem ? 'rgba(77,166,255,0.08)' : 'rgba(77,166,255,0.18)',
                color: '#4da6ff', border: '1px solid rgba(77,166,255,0.35)',
                opacity: submitting || !activeItem || problem ? 0.6 : 1,
              }}>
              {submitting ? (
                <><div className="spinner" style={{ width: 11, height: 11, borderWidth: 2, borderTopColor: '#4da6ff' }} /> Submitting…</>
              ) : (
                <><svg width="11" height="11" viewBox="0 0 24 24" fill="#4da6ff" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg> {cost && cost.steps.length > 1 ? 'Run everything' : 'Run Job'}</>
              )}
            </button>
          </div>

          {/* Offered only when there is more than one step, because otherwise it is the same
              button twice. Neither is the default: "everything" can be hours of GPU and "the
              first step" leaves the job half done, and which of those is right is not ours. */}
          {cost && cost.steps.length > 1 && !problem && (
            <button onClick={() => submit('next')} disabled={submitting || !activeItem}
              data-cy="run-next"
              className="mt-2 w-full py-1.5 rounded text-xs transition-all"
              style={{ background: 'var(--highlight-hex)', color: 'var(--muted-hex)',
                       border: '1px solid var(--border-hex)' }}>
              Run only {cost.steps[0].title.toLowerCase()} for now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
