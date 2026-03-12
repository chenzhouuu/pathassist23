// src/components/panels/AnalysisPanel.jsx
// Full HistomicsTK / Slicer CLI Web integration:
//   list CLIs → fetch XML → auto-generate form → submit job → poll → show result
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getDockerImages, getCliXmlByPath, runCliByPath, getJob, getJobs } from '../../api/index.js';
import { GIRDER_BASE } from '../../config/girder.js';

// ── Girder job status codes ───────────────────────────────────────────────────
const JOB_STATUS = { 0:'inactive', 1:'queued', 2:'running', 3:'success', 4:'error', 5:'cancelled' };
const STATUS_COLOR = {
  inactive:  'var(--muted)',
  queued:    '#f5a623',
  running:   '#4da6ff',
  success:   '#4caf82',
  error:     '#e94560',
  cancelled: 'var(--muted)',
};

// ── Parse Slicer CLI XML into structured params ───────────────────────────────
function parseXml(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const get  = (sel) => doc.querySelector(sel)?.textContent?.trim() || '';
  const groups = [];
  doc.querySelectorAll('executable > parameters').forEach(grp => {
    const label = grp.querySelector(':scope > label')?.textContent?.trim() || '';
    const params = [];
    for (const el of grp.children) {
      const tag = el.tagName;
      if (['label','description'].includes(tag)) continue;
      const name     = el.querySelector('name')?.textContent?.trim();
      if (!name) continue;
      const channel  = el.querySelector('channel')?.textContent?.trim();
      const defVal   = el.querySelector('default')?.textContent?.trim() ?? '';
      const enums    = Array.from(el.querySelectorAll('enumeration')).map(e => e.textContent.trim());
      const cons     = el.querySelector('constraints');
      params.push({
        tag,
        name,
        label:   el.querySelector('label')?.textContent?.trim() || name,
        desc:    el.querySelector('description')?.textContent?.trim() || '',
        channel,
        defVal,
        enums,
        min:  cons?.querySelector('minimum')?.textContent?.trim(),
        max:  cons?.querySelector('maximum')?.textContent?.trim(),
        step: cons?.querySelector('step')?.textContent?.trim(),
        index: el.querySelector('index')?.textContent?.trim(),
      });
    }
    if (params.length) groups.push({ label, params });
  });
  return {
    title:       get('executable > title'),
    description: get('executable > description'),
    category:    get('executable > category'),
    groups,
  };
}

// ── Whether a param should be auto-filled and hidden from the user ────────────
function isAutoFilled(p) {
  // image/file inputs are prefilled with active slide; outputs with folder.
  // float-vector (ROI) and region are shown to the user so they can set coordinates.
  return ['image','file','new-file','item','directory'].includes(p.tag);
}

// ── A single rendered form field ──────────────────────────────────────────────
function ParamField({ param, value, onChange, onDrawRoi }) {
  const { tag, label, desc, defVal, enums, min, max } = param;
  const inputStyle = {
    width:'100%', fontSize:11, padding:'5px 8px', borderRadius:5,
    background:'var(--bg)', border:'1px solid var(--border)', color:'var(--text)',
    outline:'none', fontFamily:'inherit',
  };

  const LabelEl = () => (
    <label className="block mb-1.5" style={{ color:'var(--text)', fontSize:11, fontWeight:500 }}>
      {label}
      {desc && (
        <span className="block mt-0.5 leading-relaxed" style={{ color:'var(--muted)', fontSize:9, fontWeight:400 }}>
          {desc}
        </span>
      )}
    </label>
  );

  if (tag === 'boolean') return (
    <div className="flex items-start gap-2.5">
      <input type="checkbox" checked={value === 'true'} id={param.name}
        onChange={e => onChange(e.target.checked ? 'true' : 'false')}
        style={{ accentColor:'#4da6ff', marginTop:2, flexShrink:0 }}/>
      <label htmlFor={param.name} className="cursor-pointer" style={{ color:'var(--text)', fontSize:11 }}>
        {label}
        {desc && <span className="block mt-0.5" style={{ color:'var(--muted)', fontSize:9 }}>{desc}</span>}
      </label>
    </div>
  );

  if (tag === 'string-enumeration') return (
    <div>
      <LabelEl/>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, cursor:'pointer' }}>
        {enums.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
    </div>
  );

  // ROI inputs: both <region> and <float-vector> are used by HistomicsTK for analysis_roi
  if (tag === 'region' || tag === 'float-vector') return (
    <div>
      <LabelEl/>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input type="text" value={value} onChange={e => onChange(e.target.value)}
            placeholder={tag === 'region' ? '[-1, -1, -1, -1]' : '-1,-1,-1,-1'}
            style={{ ...inputStyle, fontFamily:'monospace', paddingRight: value && value !== '-1,-1,-1,-1' ? 24 : 8 }}
            onFocus={e => e.target.style.borderColor='rgba(77,166,255,0.5)'}
            onBlur={e => e.target.style.borderColor='var(--border)'}/>
          {value && value !== '-1,-1,-1,-1' && (
            <button onClick={() => onChange('-1,-1,-1,-1')}
              style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', color:'var(--muted)', background:'none', border:'none', cursor:'pointer', fontSize:10, padding:0 }}
              title="Reset to full slide">✕</button>
          )}
        </div>
        {/* Draw ROI button — triggers rectangle selection on the viewer canvas */}
        {onDrawRoi && (
          <button onClick={onDrawRoi}
            className="flex items-center gap-1 px-2 py-1 rounded shrink-0 text-xs transition-all"
            style={{ background:'rgba(77,166,255,0.12)', color:'#4da6ff', border:'1px solid rgba(77,166,255,0.3)', whiteSpace:'nowrap' }}
            title="Draw a rectangle on the slide to set ROI coordinates">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="18" height="18" rx="1"/>
            </svg>
            Draw
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 mt-1.5">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style={{ color:'var(--muted)', fontSize:9 }}>
          left, top, width, height (pixels) &nbsp;·&nbsp; <span style={{ fontFamily:'monospace' }}>-1,-1,-1,-1</span> = entire slide
        </span>
      </div>
    </div>
  );

  if (tag === 'integer' || tag === 'float') return (
    <div>
      <LabelEl/>
      <input type="number" value={value} step={tag === 'integer' ? 1 : (param.step || 'any')}
        min={min} max={max}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
        onFocus={e => e.target.style.borderColor='rgba(77,166,255,0.5)'}
        onBlur={e => e.target.style.borderColor='var(--border)'}/>
      {(min !== undefined || max !== undefined) && (
        <div style={{ color:'var(--muted)', fontSize:9, marginTop:3 }}>
          {min !== undefined && `min: ${min}`}{min !== undefined && max !== undefined && ' · '}{max !== undefined && `max: ${max}`}
        </div>
      )}
    </div>
  );

  // string / default
  return (
    <div>
      <LabelEl/>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={defVal}
        style={inputStyle}
        onFocus={e => e.target.style.borderColor='rgba(77,166,255,0.5)'}
        onBlur={e => e.target.style.borderColor='var(--border)'}/>
    </div>
  );
}

// ── Live job status row ───────────────────────────────────────────────────────
function JobRow({ job, onDone }) {
  const status = JOB_STATUS[job.status] || 'inactive';
  const color  = STATUS_COLOR[status];
  const done   = ['success','error','cancelled'].includes(status);
  const pct    = job.progress?.current && job.progress?.total
    ? Math.round((job.progress.current / job.progress.total) * 100) : null;

  useEffect(() => {
    if (done && onDone) onDone(status);
  }, [done]); // eslint-disable-line

  return (
    <div className="rounded p-2 mb-1" style={{ background:'var(--highlight)', border:'1px solid var(--border)' }}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium truncate" style={{ color:'var(--text)', maxWidth:140 }}>
          {job.title || job.type}
        </span>
        <span className="text-xs font-mono font-bold" style={{ color, flexShrink:0 }}>{status}</span>
      </div>
      {!done && (
        <div className="h-1 rounded overflow-hidden" style={{ background:'var(--border)' }}>
          <div className="h-full rounded transition-all"
            style={{ background:color, width:`${pct ?? 40}%`, animation: pct ? 'none' : 'pulse 1.5s infinite' }}/>
        </div>
      )}
      <div style={{ color:'var(--muted)', fontSize:9, marginTop:3 }}>
        {new Date(job.created).toLocaleString()}
      </div>
    </div>
  );
}

// ── Main AnalysisPanel ────────────────────────────────────────────────────────
export default function AnalysisPanel() {
  const { activeItem, drawingMode, setDrawingMode, roiSelectResult, clearRoiSelectResult } = useStore();
  const qc = useQueryClient();

  // ── State machine: list | form | running ──────────────────────────────────
  const [view, setView]           = useState('list');  // 'list' | 'form' | 'running'
  const [selectedCli, setSelectedCli] = useState(null); // { name, run, xmlspec, imgKey }
  const [cliMeta, setCliMeta]     = useState(null);    // parsed XML
  const [formValues, setFormValues] = useState({});
  const [loadingXml, setLoadingXml] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [runningJob, setRunningJob] = useState(null);
  const [jobStatus, setJobStatus]  = useState(null);
  const [error, setError]          = useState('');
  const [cliSearch, setCliSearch]  = useState('');
  const [imageFilter, setImageFilter] = useState('all');
  const pollTimer = useRef(null);

  // ── Watch for completed ROI selection on the viewer canvas ────────────────
  // When the user draws a rectangle (roi-select mode), populate analysis_roi param.
  // float-vector: comma-separated  "x,y,w,h"  (HistomicsTK analysis_roi format)
  // region:       JSON array        "[x, y, w, h]"  (Slicer CLI <region> format)
  React.useEffect(() => {
    if (!roiSelectResult || !cliMeta) return;
    const { x, y, width, height } = roiSelectResult;
    cliMeta.groups.forEach(g => g.params.forEach(p => {
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

  // ── Fetch recent jobs ─────────────────────────────────────────────────────
  const { data: jobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: getJobs,
    refetchInterval: view === 'running' ? 2500 : 8000,
    retry: 1,
  });

  // ── Flatten docker images into CLI list ───────────────────────────────────
  // Handles all Slicer CLI Web response formats:
  //   A) { imgKey: { CLIList: { cliName: { xmlspec, run? } } } }          ← Girder v3 CLIList wrapper
  //   B) { imgKey: { cliName: { xmlspec, run? } } }                       ← direct CLI map
  //   C) { imgKey: [ { name, xmlspec, run? } ] }                          ← array format
  //   D) { imgKey: { tag: { cliName: { xmlspec, run? } } } }              ← tag-nested (YOUR format)
  // 'run' is derived from xmlspec when not present: replace /xml suffix with /run
  const cliList = React.useMemo(() => {
    if (!images) return [];
    const META_KEYS = new Set(['name','tag','type','description','_id','image','status','latest']);
    const deriveRun = (xmlspec) => xmlspec ? xmlspec.replace(/\/xml(\?.*)?$/, '/run') : null;
    const isCli = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.run || v.xmlspec || v.xml_spec);
    const list  = [];

    const push = (imgKey, cliName, cli) => {
      const xmlspec = cli.xmlspec || cli.xml_spec;
      const run     = cli.run || deriveRun(xmlspec);
      if (!xmlspec && !run) return;
      list.push({ imgKey, name: cliName, title: cli.title || cli.desc || cliName, run, xmlspec });
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

  // ── Select a CLI: fetch + parse its XML ───────────────────────────────────
  const openCli = useCallback(async (cli) => {
    setSelectedCli(cli);
    setError('');
    setLoadingXml(true);
    setView('form');
    try {
      const xml  = await getCliXmlByPath(cli.xmlspec);
      const meta = parseXml(xml);
      setCliMeta(meta);
      // Seed form with defaults
      const defaults = {};
      meta.groups.forEach(g => g.params.forEach(p => {
        if (!isAutoFilled(p)) defaults[p.name] = p.defVal ?? '';
      }));
      setFormValues(defaults);
    } catch (e) {
      setError('Failed to load algorithm description: ' + e.message);
    }
    setLoadingXml(false);
  }, []);

  // ── Submit job ────────────────────────────────────────────────────────────
  const submitJob = useCallback(async () => {
    if (!selectedCli || !cliMeta || !activeItem) return;
    setSubmitting(true);
    setError('');
    try {
      const token = localStorage.getItem('girderToken') || '';
      const params = {};

      cliMeta.groups.forEach(g => g.params.forEach(p => {
        // Slicer CLI Web /run expects raw Girder ObjectId strings — NOT JSON-wrapped objects.
        // Passing {"_id":"...","_modelType":"item"} causes "Invalid ObjectId" on the server.
        const isInput  = !p.channel || p.channel === 'input';
        const isOutput = p.channel === 'output';
        if (p.tag === 'image') {
          // Images default to input; only treat as output when explicitly declared output
          params[p.name] = isOutput ? activeItem.folderId : activeItem._id;
        } else if (['new-file','file'].includes(p.tag)) {
          // new-file / file default to output (write result); input file uses item ID
          params[p.name] = isInput && p.tag === 'file' ? activeItem._id : activeItem.folderId;
        } else if (p.tag === 'item') {
          params[p.name] = isInput ? activeItem._id : activeItem.folderId;
        } else if (p.tag === 'directory') {
          params[p.name] = activeItem.folderId;
        } else if (!isAutoFilled(p)) {
          const val = formValues[p.name];
          const useVal = (val !== '' && val !== undefined) ? String(val) : (p.defVal !== '' ? p.defVal : undefined);
          if (useVal !== undefined) params[p.name] = useVal;
        }
      }));
      // Slicer CLI worker needs Girder connection to upload results
      params['girderApiUrl']  = GIRDER_BASE;
      params['girderToken']   = localStorage.getItem('girderToken') || '';

      const job = await runCliByPath(selectedCli.run, params);
      setRunningJob(job);
      setJobStatus('queued');
      setView('running');
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) {
      setError('Submission failed: ' + (e?.response?.data?.message || e.message));
    }
    setSubmitting(false);
  }, [selectedCli, cliMeta, activeItem, formValues, qc]);

  // ── Poll running job ──────────────────────────────────────────────────────
  useEffect(() => {
    if (view !== 'running' || !runningJob?._id) return;
    const poll = async () => {
      try {
        const j = await getJob(runningJob._id);
        const s = JOB_STATUS[j.status] || 'inactive';
        setJobStatus(s);
        setRunningJob(j);
        if (['success','error','cancelled'].includes(s)) {
          clearInterval(pollTimer.current);
          if (s === 'success') {
            // Reload annotations — the CLI may have written new annotation(s)
            qc.invalidateQueries({ queryKey: ['annotations'] });
          }
        }
      } catch (_) {}
    };
    pollTimer.current = setInterval(poll, 2500);
    return () => clearInterval(pollTimer.current);
  }, [view, runningJob?._id]); // eslint-disable-line

  const pct = runningJob?.progress?.current && runningJob?.progress?.total
    ? Math.round((runningJob.progress.current / runningJob.progress.total) * 100) : null;

  // ── Group CLIs by image for display ──────────────────────────────────────
  const grouped = React.useMemo(() => {
    const map = {};
    cliList.forEach(cli => {
      if (!map[cli.imgKey]) map[cli.imgKey] = [];
      map[cli.imgKey].push(cli);
    });
    return map;
  }, [cliList]);

  const imageKeys = React.useMemo(
    () => Object.keys(grouped).sort((a, b) => a.localeCompare(b)),
    [grouped],
  );

  const filteredGroupedEntries = React.useMemo(() => {
    const q = cliSearch.trim().toLowerCase();
    return Object.entries(grouped)
      .filter(([imgKey]) => imageFilter === 'all' || imgKey === imageFilter)
      .map(([imgKey, clis]) => {
        const filteredClis = clis.filter(cli => {
          if (!q) return true;
          return (cli.title || '').toLowerCase().includes(q) || (cli.name || '').toLowerCase().includes(q);
        });
        return [imgKey, filteredClis];
      })
      .filter(([, clis]) => clis.length > 0);
  }, [grouped, cliSearch, imageFilter]);

  const filteredCliCount = React.useMemo(
    () => filteredGroupedEntries.reduce((sum, [, clis]) => sum + clis.length, 0),
    [filteredGroupedEntries],
  );

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: LIST view
  // ──────────────────────────────────────────────────────────────────────────
  if (view === 'list') return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-2">

        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wide" style={{ color:'var(--muted)', fontSize:10 }}>
            Available Algorithms
          </span>
          {!activeItem && (
            <span className="text-xs" style={{ color:'#f5a623' }}>No slide open</span>
          )}
        </div>

        <div className="mb-2 flex items-center gap-1.5">
          <input
            value={cliSearch}
            onChange={e => setCliSearch(e.target.value)}
            placeholder="Filter algorithms..."
            className="flex-1 rounded px-2 py-1 text-xs outline-none"
            style={{ background:'var(--bg)', border:'1px solid var(--border)', color:'var(--text)' }}
            onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.45)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
          <select
            value={imageFilter}
            onChange={e => setImageFilter(e.target.value)}
            className="rounded px-2 py-1 text-xs outline-none"
            style={{ background:'var(--bg)', border:'1px solid var(--border)', color:'var(--text)', minWidth:100 }}
            onFocus={e => e.target.style.borderColor = 'rgba(77,166,255,0.45)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}>
            <option value="all">All Images</option>
            {imageKeys.map(key => (
              <option key={key} value={key}>{key}</option>
            ))}
          </select>
        </div>

        <div className="mb-2 text-xs" style={{ color:'var(--muted)', fontSize:10 }}>
          {filteredCliCount} / {cliList.length} algorithm{cliList.length !== 1 ? 's' : ''}
        </div>

        {loadingImages && (
          <div className="flex justify-center py-6"><div className="spinner" style={{ width:20,height:20,borderWidth:2 }}/></div>
        )}

        {!loadingImages && cliList.length === 0 && (
          <div className="text-center py-4" style={{ color:'var(--muted)' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
              className="mx-auto mb-2" style={{ opacity:0.4 }}>
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <div style={{ fontSize:11 }}>No CLI tasks parsed</div>
            <div style={{ fontSize:10, marginTop:2, marginBottom:8 }}>
              {images ? `API returned ${Object.keys(images).length} image(s)` : 'API returned no data'}
            </div>
            {/* Debug: show raw API response so we can identify the format */}
            {images && Object.keys(images).length > 0 && (
              <details className="text-left mt-2">
                <summary className="text-xs cursor-pointer px-2" style={{ color:'#f5a623' }}>
                  Show raw API response (copy to share)
                </summary>
                <pre className="text-xs mt-1 p-2 rounded overflow-auto max-h-48 text-left"
                  style={{ background:'var(--bg)', border:'1px solid var(--border)', color:'var(--text)', fontSize:9, whiteSpace:'pre-wrap', wordBreak:'break-all' }}>
                  {JSON.stringify(images, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}

        {!loadingImages && cliList.length > 0 && filteredCliCount === 0 && (
          <div className="text-center py-4" style={{ color:'var(--muted)', fontSize:11 }}>
            No algorithms match the current filter.
          </div>
        )}

        {filteredGroupedEntries.map(([imgKey, clis]) => (
          <div key={imgKey} className="mb-3">
            <div className="font-mono truncate mb-1 px-1" style={{ color:'var(--muted)', fontSize:9 }}
              title={imgKey}>{imgKey}</div>
            <div className="flex flex-col gap-0.5">
              {clis.map(cli => (
                <button key={cli.name}
                  onClick={() => openCli(cli)}
                  disabled={!activeItem}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-left transition-all group"
                  style={{ background:'var(--highlight)', border:'1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor='rgba(77,166,255,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor='var(--border)'}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="#4da6ff" stroke="none">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  <span className="flex-1 text-xs" style={{ color:'var(--text)' }}>{cli.title}</span>
                  <span className="text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color:'#4da6ff' }}>Run →</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* Recent jobs */}
        {jobs && jobs.length > 0 && (
          <div className="mt-3 pt-2" style={{ borderTop:'1px solid var(--border)' }}>
            <div className="text-xs font-semibold uppercase tracking-wide mb-2"
              style={{ color:'var(--muted)', fontSize:10 }}>Recent Jobs</div>
            {jobs.slice(0, 6).map(job => {
              const s = JOB_STATUS[job.status] || 'inactive';
              return (
                <div key={job._id} className="flex items-start gap-2 py-1 px-1 rounded mb-0.5 hover:bg-black/5 transition-colors">
                  <span className="font-mono text-xs mt-0.5 w-2 text-center flex-shrink-0"
                    style={{ color: STATUS_COLOR[s] }}>
                    {s === 'success' ? '✓' : s === 'error' ? '✗' : s === 'running' ? '↻' : '·'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color:'var(--text)' }}>{job.title || job.type}</div>
                    <div style={{ color:'var(--muted)', fontSize:9 }}>{new Date(job.created).toLocaleString()}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: FORM view
  // ──────────────────────────────────────────────────────────────────────────
  if (view === 'form') return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Form header */}
      <div className="flex items-center gap-2 px-2 py-1.5 shrink-0"
        style={{ borderBottom:'1px solid var(--border)', background:'var(--bg-toolbar)' }}>
        <button onClick={() => { setView('list'); setCliMeta(null); setError(''); }}
          className="p-0.5 rounded hover:bg-black/5 transition-colors"
          style={{ color:'var(--muted)' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate" style={{ color:'var(--text)' }}>
            {cliMeta?.title || selectedCli?.title || selectedCli?.name}
          </div>
          {cliMeta?.category && (
            <div style={{ color:'var(--muted)', fontSize:9 }}>{cliMeta.category}</div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loadingXml && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <div className="spinner" style={{ width:20, height:20, borderWidth:2 }}/>
            <div style={{ color:'var(--muted)', fontSize:11 }}>Loading parameters…</div>
          </div>
        )}

        {error && (
          <div className="rounded p-2 mb-2 text-xs" style={{ background:'rgba(233,69,96,0.1)', border:'1px solid rgba(233,69,96,0.3)', color:'#e94560' }}>
            {error}
          </div>
        )}

        {/* ROI drawing active banner */}
        {drawingMode === 'roi-select' && (
          <div className="mx-2 mb-2 px-3 py-2 rounded-lg flex items-center gap-2"
            style={{ background:'rgba(77,166,255,0.12)', border:'1px solid rgba(77,166,255,0.35)' }}>
            <div className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background:'#4da6ff' }}/>
            <span style={{ color:'#4da6ff', fontSize:11 }}>
              Draw a rectangle on the slide…
            </span>
            <button onClick={() => setDrawingMode(null)} className="ml-auto text-xs shrink-0"
              style={{ color:'var(--muted)' }}>Esc</button>
          </div>
        )}

        {cliMeta && !loadingXml && (
          <>
            {/* Description */}
            {cliMeta.description && (
              <div className="rounded-lg p-2.5 mb-3 text-xs leading-relaxed"
                style={{ background:'var(--highlight)', border:'1px solid var(--border)', color:'var(--muted)' }}>
                {cliMeta.description}
              </div>
            )}

            {/* Input slide card — mirrors DSA's "Input Image" field */}
            <div className="rounded-lg p-2.5 mb-3" style={{ background:'var(--highlight)', border:'1px solid var(--border)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
                <span style={{ color:'var(--muted)', fontSize:9, textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:600 }}>
                  Input Image
                </span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded"
                style={{ background:'var(--bg)', border:'1px solid var(--border)' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                <span className="text-xs truncate font-medium" style={{ color:'#4da6ff', flex:1 }}>
                  {activeItem?.name || '—'}
                </span>
                <span className="text-xs shrink-0" style={{ color:'var(--muted)' }}>
                  {activeItem?.size ? `${(activeItem.size / 1024 / 1024 / 1024).toFixed(2)} GB` : ''}
                </span>
              </div>
              {/* Show output folder too */}
              <div className="mt-1.5" style={{ color:'var(--muted)', fontSize:9 }}>
                Output → same folder as input slide
              </div>
            </div>

            {/* User-configurable parameters */}
            {cliMeta.groups.map(group => {
              const userParams = group.params.filter(p => !isAutoFilled(p));
              if (userParams.length === 0) return null;
              return (
                <div key={group.label} className="mb-3">
                  {group.label && (
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex-1 h-px" style={{ background:'var(--border)' }}/>
                      <span style={{ color:'var(--muted)', fontSize:9, textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:600, flexShrink:0 }}>
                        {group.label}
                      </span>
                      <div className="flex-1 h-px" style={{ background:'var(--border)' }}/>
                    </div>
                  )}
                  <div className="flex flex-col gap-3">
                    {userParams.map(p => (
                      <ParamField key={p.name} param={p}
                        value={formValues[p.name] ?? p.defVal}
                        onChange={v => setFormValues(prev => ({ ...prev, [p.name]: v }))}
                        onDrawRoi={(p.tag === 'float-vector' || p.tag === 'region')
                          ? () => setDrawingMode('roi-select')
                          : undefined}/>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Submit bar */}
      {cliMeta && !loadingXml && (
        <div className="shrink-0 px-2 py-2 flex gap-2" style={{ borderTop:'1px solid var(--border)' }}>
          <button onClick={() => { setView('list'); setCliMeta(null); setError(''); }}
            className="flex items-center justify-center px-3 py-2 rounded text-xs transition-all"
            style={{ background:'var(--highlight)', color:'var(--muted)', border:'1px solid var(--border)' }}>
            Cancel
          </button>
          <button onClick={submitJob} disabled={submitting || !activeItem}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded font-semibold text-xs transition-all"
            style={{ background: submitting || !activeItem ? 'rgba(77,166,255,0.08)' : 'rgba(77,166,255,0.18)',
              color:'#4da6ff', border:'1px solid rgba(77,166,255,0.35)',
              opacity: submitting || !activeItem ? 0.6 : 1 }}>
            {submitting ? (
              <><div className="spinner" style={{ width:11, height:11, borderWidth:2, borderTopColor:'#4da6ff' }}/> Submitting…</>
            ) : (
              <><svg width="11" height="11" viewBox="0 0 24 24" fill="#4da6ff" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg> Run Job</>
            )}
          </button>
        </div>
      )}
    </div>
  );

  // ──────────────────────────────────────────────────────────────────────────
  // RENDER: RUNNING view
  // ──────────────────────────────────────────────────────────────────────────
  const done = ['success','error','cancelled'].includes(jobStatus);
  const jobColor = STATUS_COLOR[jobStatus] || 'var(--muted)';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 shrink-0"
        style={{ borderBottom:'1px solid var(--border)', background:'var(--bg-toolbar)' }}>
        {done && (
          <button onClick={() => setView('list')}
            className="p-0.5 rounded hover:bg-black/5 transition-colors"
            style={{ color:'var(--muted)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        )}
        <div className="text-xs font-semibold" style={{ color:'var(--text)' }}>
          {selectedCli?.title || selectedCli?.name}
        </div>
        <div className="ml-auto text-xs font-mono font-bold" style={{ color: jobColor }}>
          {jobStatus}
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-4">
        {/* Progress ring / check / cross */}
        <div className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{ background: `${jobColor}18`, border:`2px solid ${jobColor}40` }}>
          {!done ? (
            <div className="spinner" style={{ width:28, height:28, borderWidth:2, borderColor:`${jobColor}40`, borderTopColor:jobColor }}/>
          ) : jobStatus === 'success' ? (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={jobColor} strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={jobColor} strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          )}
        </div>

        {/* Progress bar */}
        {!done && (
          <div className="w-full rounded overflow-hidden" style={{ height:4, background:'var(--border)' }}>
            <div className="h-full rounded transition-all duration-500"
              style={{ background:jobColor, width:`${pct ?? 0}%`,
                animation: pct ? 'none' : 'pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite' }}/>
          </div>
        )}

        <div className="text-center">
          <div className="text-xs font-medium" style={{ color:'var(--text)' }}>
            {!done ? (pct !== null ? `${pct}% complete` : 'Processing…') :
              jobStatus === 'success' ? 'Analysis complete' : 'Job ' + jobStatus}
          </div>
          {runningJob?.log?.length > 0 && (
            <div className="text-xs mt-1 opacity-60 truncate max-w-[180px]"
              style={{ color:'var(--muted)' }}>
              {runningJob.log.slice(-1)[0]}
            </div>
          )}
        </div>

        {jobStatus === 'success' && (
          <div className="text-center">
            <div className="text-xs mb-2" style={{ color:'var(--muted)' }}>
              Results saved — annotations panel will refresh automatically.
            </div>
            <button onClick={() => setView('list')}
              className="text-xs px-4 py-1.5 rounded font-medium"
              style={{ background:'rgba(76,175,130,0.15)', color:'#4caf82', border:'1px solid rgba(76,175,130,0.3)' }}>
              Back to Analysis
            </button>
          </div>
        )}

        {jobStatus === 'error' && (
          <button onClick={() => setView('form')}
            className="text-xs px-4 py-1.5 rounded font-medium"
            style={{ background:'rgba(233,69,96,0.1)', color:'#e94560', border:'1px solid rgba(233,69,96,0.3)' }}>
            Back to Form
          </button>
        )}
      </div>
    </div>
  );
}
