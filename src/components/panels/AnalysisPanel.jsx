// src/components/panels/AnalysisPanel.jsx
// One algorithm catalog (Inc 6 · 02). HistomicsTK docker CLIs and the five native PathAssist tools
// appear in the same searchable list, and clicking either opens a form built by the same renderer.
//
// A CLI describes its form in Slicer XML; a native tool declares the same shape as data in
// `analysis/nativeCatalog.js`. That is the only difference between the two paths here — everything
// downstream of "we have `{title, description, groups}`" is shared.
//
// The old `running` view is gone. A submitted job is not a modal state: the panel returns to the
// list, and the Runs section beneath the catalog (03) is where every run — this slide's, other
// slides', other users' — is watched.
//
// Native entries still submit to their existing endpoints. Moving each kind onto the Celery path is
// 05–07, one at a time, and until a kind moves its own tab stays where it is.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../../store/index.js';
import { getDockerImages, getCliXmlByPath, runCliByPath } from '../../api/index.js';
import { listArtifacts } from '../../api/preprocessApi.js';
import { GIRDER_BASE } from '../../config/girder.js';
import ParamField from './analysis/ParamField.jsx';
import RunsSection from './analysis/RunsSection.jsx';
import { cliRunParams } from './analysis/cliParams.js';
import { isAutoFilled, parseXml } from './analysis/parseXml.js';
import {
  NATIVE_GROUP, NATIVE_TOOLS, firstProblem, isEnabled, seedValues, toolParams,
} from './analysis/nativeCatalog.js';
import { useRegionSelect } from './useRegionSelect.js';

// ── Main AnalysisPanel ────────────────────────────────────────────────────────
export default function AnalysisPanel() {
  const { activeItem, drawingMode, setDrawingMode, roiSelectResult, clearRoiSelectResult } = useStore();
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
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');

  const isNative = selected?.source === 'native';

  // ── Watch for completed ROI selection on the viewer canvas (CLI path) ──────
  // When the user draws a rectangle (roi-select mode), populate analysis_roi param.
  // float-vector: comma-separated  "x,y,w,h"  (HistomicsTK analysis_roi format)
  // region:       JSON array        "[x, y, w, h]"  (Slicer CLI <region> format)
  // Native tools do not go through this: their region is the shared `useRegionSelect` state.
  useEffect(() => {
    if (!roiSelectResult || !meta || isNative) return;
    const { x, y, width, height } = roiSelectResult;
    meta.groups.forEach(g => g.params.forEach(p => {
      if (!isAutoFilled(p)) {
        if (p.tag === 'float-vector') {
          setFormValues(prev => ({ ...prev, [p.name]: `${x},${y},${width},${height}` }));
        } else if (p.tag === 'region') {
          setFormValues(prev => ({ ...prev, [p.name]: `[${x}, ${y}, ${width}, ${height}]` }));
        }
      }
    }));
    clearRoiSelectResult();
  }, [roiSelectResult]); // eslint-disable-line

  // ── Fetch docker images ───────────────────────────────────────────────────
  const { data: images, isLoading: loadingImages } = useQuery({
    queryKey: ['docker-images'],
    queryFn: getDockerImages,
    retry: 1,
    staleTime: 60_000,
  });

  // ── This slide's artifacts — what the upstream pickers choose from ────────
  const { data: artifacts, isLoading: loadingArtifacts } = useQuery({
    queryKey: ['artifacts', activeItem?._id],
    queryFn: () => listArtifacts(activeItem._id),
    enabled: !!activeItem?._id && view === 'form' && isNative,
    retry: 1,
  });

  // ── Flatten docker images into CLI list ───────────────────────────────────
  // Handles all Slicer CLI Web response formats:
  //   A) { imgKey: { CLIList: { cliName: { xmlspec, run? } } } }          ← Girder v3 CLIList wrapper
  //   B) { imgKey: { cliName: { xmlspec, run? } } }                       ← direct CLI map
  //   C) { imgKey: [ { name, xmlspec, run? } ] }                          ← array format
  //   D) { imgKey: { tag: { cliName: { xmlspec, run? } } } }              ← tag-nested (YOUR format)
  // 'run' is derived from xmlspec when not present: replace /xml suffix with /run
  const cliList = useMemo(() => {
    if (!images) return [];
    const META_KEYS = new Set(['name', 'tag', 'type', 'description', '_id', 'image', 'status', 'latest']);
    const deriveRun = (xmlspec) => xmlspec ? xmlspec.replace(/\/xml(\?.*)?$/, '/run') : null;
    const isCli = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.run || v.xmlspec || v.xml_spec);
    const list = [];

    const push = (imgKey, cliName, cli) => {
      const xmlspec = cli.xmlspec || cli.xml_spec;
      const run = cli.run || deriveRun(xmlspec);
      if (!xmlspec && !run) return;
      list.push({
        source: 'cli', group: imgKey, name: cliName,
        title: cli.title || cli.desc || cliName, run, xmlspec,
      });
    };

    Object.entries(images).forEach(([imgKey, imgVal]) => {
      if (!imgVal || typeof imgVal !== 'object') return;

      // Format C — array of CLI objects
      if (Array.isArray(imgVal)) {
        imgVal.forEach(cli => push(imgKey, cli.name || cli.title, cli));
        return;
      }

      // Format A — CLIList wrapper (Girder v3)
      if (imgVal.CLIList && typeof imgVal.CLIList === 'object') {
        Object.entries(imgVal.CLIList).forEach(([cliName, cli]) => push(imgKey, cliName, cli));
        return;
      }

      // Format B — imgVal keys are CLI names directly
      const lvl1 = Object.entries(imgVal).filter(([k, v]) => !META_KEYS.has(k) && isCli(v));
      if (lvl1.length > 0) {
        lvl1.forEach(([cliName, cli]) => push(imgKey, cliName, cli));
        return;
      }

      // Format D — imgVal has tag wrapper (e.g. "latest") before CLI names
      // Structure: { imageName: { "latest": { cliName: { run, xmlspec } } } }
      let found = false;
      Object.entries(imgVal).forEach(([tagKey, tagVal]) => {
        if (!tagVal || typeof tagVal !== 'object' || Array.isArray(tagVal)) return;
        if (isCli(tagVal)) { push(imgKey, tagKey, tagVal); found = true; return; }
        const lvl2 = Object.entries(tagVal).filter(([k, v]) => !META_KEYS.has(k) && isCli(v));
        if (lvl2.length > 0) {
          lvl2.forEach(([cliName, cli]) => push(imgKey, cliName, cli));
          found = true;
        }
      });
      if (!found) console.warn('[AnalysisPanel] Unrecognized docker_image format for:', imgKey, JSON.stringify(imgVal).slice(0, 200));
    });

    return list;
  }, [images]);

  // ── The one catalog: native tools first, then each docker image ───────────
  // Native entries are always present, so the list is never empty and the panel is usable on a
  // deployment with no docker images pulled at all.
  const entries = useMemo(() => ([
    ...NATIVE_TOOLS.map(t => ({ source: 'native', group: NATIVE_GROUP, name: t.id, title: t.title, tool: t })),
    ...cliList,
  ]), [cliList]);

  const groupKeys = useMemo(() => {
    const cliKeys = [...new Set(cliList.map(c => c.group))].sort((a, b) => a.localeCompare(b));
    return [NATIVE_GROUP, ...cliKeys];
  }, [cliList]);

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

  // ── Open an entry: fetch + parse XML, or read the declaration ─────────────
  const openEntry = useCallback(async (entry) => {
    setSelected(entry);
    setError('');
    setSubmitted(null);
    setView('form');

    if (entry.source === 'native') {
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
      return;
    }

    setLoadingForm(true);
    try {
      const xml = await getCliXmlByPath(entry.xmlspec);
      const parsed = parseXml(xml);
      setMeta(parsed);
      // Seed form with defaults
      const defaults = {};
      parsed.groups.forEach(g => g.params.forEach(p => {
        if (!isAutoFilled(p)) defaults[p.name] = p.defVal ?? '';
      }));
      setFormValues(defaults);
    } catch (e) {
      setError('Failed to load algorithm description: ' + e.message);
    }
    setLoadingForm(false);
  }, []);

  const backToList = useCallback(() => {
    setView('list');
    setMeta(null);
    setSelected(null);
    setError('');
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    if (!selected || !meta || !activeItem) return;
    setSubmitting(true);
    setError('');
    try {
      if (selected.source === 'native') {
        await selected.tool.submit(activeItem._id, formValues, { roi: region.roi });
        qc.invalidateQueries({ queryKey: ['artifacts', activeItem._id] });
      } else {
        // Slicer CLI Web /run expects raw Girder ObjectId strings — NOT JSON-wrapped objects.
        // Passing {"_id":"...","_modelType":"item"} causes "Invalid ObjectId" on the server.
        // The rest of the mapping is `cliParams.js`, copied from slicer_cli_web's own widgets.
        const params = cliRunParams({
          groups: meta.groups, values: formValues, item: activeItem, cliName: selected.name,
        });
        // Slicer CLI worker needs Girder connection to upload results
        params['girderApiUrl'] = GIRDER_BASE;
        params['girderToken'] = localStorage.getItem('girderToken') || '';
        await runCliByPath(selected.run, params);
      }
      // Do not wait out the poll interval to see what was just submitted.
      qc.invalidateQueries({ queryKey: ['pathassist-runs'] });
      setSubmitted({ title: meta.title || selected.title || selected.name });
      // A submitted job is not a modal state — back to the list, and it is watched in Runs.
      setView('list');
      setMeta(null);
      setSelected(null);
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
              {submitted.title} submitted
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

        {loadingImages && (
          <div className="flex justify-center py-3"><div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /></div>
        )}

        {!loadingImages && shownCount === 0 && (
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

        {/* Docker images were expected but none parsed — keep the raw response reachable */}
        {!loadingImages && cliList.length === 0 && images && Object.keys(images).length > 0 && (
          <details className="text-left mt-2">
            <summary className="text-xs cursor-pointer px-2" style={{ color: '#f5a623' }}>
              {Object.keys(images).length} docker image(s) returned, none parsed — show raw response
            </summary>
            <pre className="text-xs mt-1 p-2 rounded overflow-auto max-h-48 text-left"
              style={{ background: 'var(--bg)', border: '1px solid var(--border-hex)', color: 'var(--text)', fontSize: 9, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(images, null, 2)}
            </pre>
          </details>
        )}

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
  const problem = isNative && meta ? firstProblem(meta, formValues, { roi: region.roi }) : null;

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
          {(meta?.category || isNative) && (
            <div style={{ color: 'var(--muted-hex)', fontSize: 9 }}>
              {meta?.category || NATIVE_GROUP}
            </div>
          )}
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

        {/* ROI drawing active banner (CLI path — native tools show it in the field itself) */}
        {!isNative && drawingMode === 'roi-select' && (
          <div className="mx-2 mb-2 px-3 py-2 rounded-lg flex items-center gap-2"
            style={{ background: 'rgba(77,166,255,0.12)', border: '1px solid rgba(77,166,255,0.35)' }}>
            <div className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: '#4da6ff' }} />
            <span style={{ color: '#4da6ff', fontSize: 11 }}>
              Draw a rectangle on the slide…
            </span>
            <button onClick={() => setDrawingMode(null)} className="ml-auto text-xs shrink-0"
              style={{ color: 'var(--muted-hex)' }}>Esc</button>
          </div>
        )}

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
                {isNative
                  ? 'Output → this slide’s artifacts, in Workspace'
                  : 'Output → same folder as input slide'}
              </div>
            </div>

            {/* User-configurable parameters */}
            {meta.groups.map(group => {
              const userParams = group.params.filter(p => isNative || !isAutoFilled(p));
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
                        onChange={v => setFormValues(prev => ({ ...prev, [p.name]: v }))}
                        onDrawRoi={(!isNative && (p.tag === 'float-vector' || p.tag === 'region'))
                          ? () => setDrawingMode('roi-select')
                          : undefined}
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
          <div className="flex gap-2">
            <button onClick={backToList}
              className="flex items-center justify-center px-3 py-2 rounded text-xs transition-all"
              style={{ background: 'var(--highlight-hex)', color: 'var(--muted-hex)', border: '1px solid var(--border-hex)' }}>
              Cancel
            </button>
            <button onClick={submit} disabled={submitting || !activeItem || !!problem}
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
                </svg> Run Job</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
