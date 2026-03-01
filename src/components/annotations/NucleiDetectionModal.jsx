// src/components/annotations/NucleiDetectionModal.jsx
// Submit a Slicer CLI nuclei detection job for a selected ROI annotation.
import React, { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getDockerImages, getCliXml, getCliXmlByPath, runCliJob, runCliByPath, getJob, getItemFiles } from '../../api/index.js';
import { getAnnotationBBox } from './annotationUtils.js';
import { GIRDER_BASE } from '../../config/girder.js';

// Parse Slicer CLI XML → extract parameter names by element type
function parseCliXml(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const params = {};

    // Find the <name> text of the first element matching `tag` whose optional
    // <channel> child equals `channel` (if provided).
    const findName = (tag, channel) => {
      for (const el of doc.querySelectorAll(tag)) {
        const ch = el.querySelector('channel')?.textContent?.trim();
        if (!channel || ch === channel) {
          const name = el.querySelector('name')?.textContent?.trim();
          if (name) return name;
        }
      }
      return undefined;
    };

    // NucleiDetection uses <image channel=input>, <new-file channel=output>,
    // and <float-vector> for analysis_roi (NOT <region>).
    params.inputImage = findName('image', 'input') || findName('image') || findName('item', 'input');
    // HistomicsTK uses <new-file> not <file channel="output">
    params.outputFile = findName('new-file', 'output') || findName('new-file')
                      || findName('file', 'output') || findName('file-out');
    // HistomicsTK encodes ROI as <float-vector name="analysis_roi">, not <region>
    params.roiParam   = findName('region') || findName('roi')
                      || findName('float-vector') || undefined;
    params.title       = doc.querySelector('title')?.textContent?.trim() || '';
    params.description = doc.querySelector('description')?.textContent?.trim() || '';

    console.log('[NucleiModal] parsed CLI params:', params);
    return params;
  } catch (_) {
    return {};
  }
}

// Build the params object for POST /slicer_cli_web/.../run
// fileId: the Girder file _id inside the item (Slicer CLI Web validates as file, not item)
function buildJobParams(cliParams, item, bbox, fileId) {
  const params = {};
  // Slicer CLI Web <image> params require a file ID, not an item ID.
  const inputId  = fileId || item._id;
  const folderId = item.folderId;

  // Validate all 4 ROI values are finite numbers before building the string.
  // If any value is undefined/NaN, Python silently drops non-numeric tokens,
  // leaving fewer than 4 elements → ValueError in the CLI.
  const bx = Number(bbox?.x), by = Number(bbox?.y);
  const bw = Number(bbox?.width), bh = Number(bbox?.height);
  // Slicer CLI Web 'region' type expects JSON array format (python json.dumps),
  // e.g. "[x, y, w, h]" — NOT comma-separated "x,y,w,h"
  const roiStr = (bbox && isFinite(bx) && isFinite(by) && bw > 0 && bh > 0)
    ? `[${Math.round(bx)}, ${Math.round(by)}, ${Math.round(bw)}, ${Math.round(bh)}]`
    : '[-1, -1, -1, -1]';

  if (cliParams.inputImage)  params[cliParams.inputImage]  = inputId;
  if (cliParams.outputFile)  params[cliParams.outputFile]  = folderId;
  if (cliParams.roiParam)    params[cliParams.roiParam]    = roiStr;

  // Always include these common Slicer CLI girder params
  // Use GIRDER_BASE so the worker calls the real server, not localhost (dev)
  params['girderApiUrl']   = GIRDER_BASE;
  params['girderToken']    = localStorage.getItem('girderToken') || '';
  return params;
}

// Extract CLIs using KEY names from the response (not URL parsing).
// The docker_image API returns: { "imageName": { "cliName": { run, xmlspec, ... } } }
// or: { "imageName": { "tag": { "cliName": { ... } } } }
// We walk the structure and treat any key whose VALUE has run/xmlspec as a CLI name.
function extractNucleiClis(images) {
  const pattern = /nucle|cell|detect|segment|hover|stardist|deepliif/i;
  const seen = new Set();
  const all  = [];

  function addCli(imageName, cliName, runUrl, xmlUrl) {
    if (!pattern.test(cliName) && !pattern.test(imageName)) return;
    const key = `${imageName}::${cliName}`;
    // Capture the run/xml URLs exactly as Girder provides them — these are the
    // actual registered route paths. Using them directly avoids guessing the
    // URL encoding/format (e.g. with or without tag, encoded slashes, etc.).
    if (!seen.has(key)) { seen.add(key); all.push({ imageName, cliName, runUrl, xmlUrl }); }
  }

  function scanUnderImage(node, imageName, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return;
    Object.entries(node).forEach(([key, val]) => {
      if (!val || typeof val !== 'object') return;
      if (val.run || val.xmlspec || val.type) {
        // key is a CLI name; val.run / val.xmlspec are the Girder-provided endpoint paths
        addCli(imageName, key, val.run, val.xmlspec);
      } else {
        // key might be a tag — recurse one more level
        scanUnderImage(val, imageName, depth + 1);
      }
    });
  }

  if (!images || typeof images !== 'object') return all;

  if (Array.isArray(images)) {
    // Array format: [{ image, tag, CLIList }]
    images.forEach(img => {
      const name = img.image || img.name || '';
      const tag  = img.tag || '';
      const full = tag ? `${name}:${tag}` : name;
      scanUnderImage(img.CLIList || img.cliList || {}, full, 0);
    });
  } else {
    // Object format: top-level keys are image names
    Object.entries(images).forEach(([imageName, val]) => {
      scanUnderImage(val, imageName, 0);
    });
  }

  console.log('[NucleiModal] extractNucleiClis result:', JSON.stringify(all));
  return all;
}

const STATUS_LABELS = { 0:'Inactive', 1:'Queued', 2:'Running', 3:'Success', 4:'Error', 5:'Cancelled' };

export default function NucleiDetectionModal({ ann, item, onClose }) {
  const qc = useQueryClient();
  const bbox = getAnnotationBBox(ann);

  const [clis, setClis]       = useState([]);
  const [loadingClis, setLoadingClis] = useState(true);
  const [selected, setSelected] = useState(null);      // { imageName, cliName }
  const [step, setStep]       = useState('select');    // 'select' | 'running' | 'done' | 'error'
  const [jobStatus, setJobStatus] = useState(null);    // job object from Girder
  const [errorMsg, setErrorMsg] = useState('');

  const [rawApiInfo, setRawApiInfo] = useState('');

  // Load available CLIs — try API first, then probe using actual image names as fallback
  useEffect(() => {
    const PROBE_CLIS = ['NucleiDetection', 'NucleiClassification', 'ComputeNucleiFeatures'];

    async function load() {
      let images = null;
      let imageKeys = [];

      // Step 1: fetch docker_image list
      try {
        images = await getDockerImages();
        imageKeys = images ? Object.keys(images) : [];
        setRawApiInfo(`API keys(${imageKeys.length}): ${imageKeys.slice(0, 6).join(', ')}`);
      } catch (e) {
        setRawApiInfo(`API error: ${e?.message}`);
      }

      // Step 2: try to extract CLIs from response structure
      const fromApi = extractNucleiClis(images);
      if (fromApi.length > 0) {
        setClis(fromApi);
        if (fromApi.length === 1) setSelected(fromApi[0]);
        setLoadingClis(false);
        return;
      }

      // Step 3: fallback — probe using ACTUAL image names from the API keys
      const probeImages = imageKeys.length > 0
        ? imageKeys
        : ['dsarchive/histomicstk', 'dsarchive/histomicstk:latest'];

      const probed = [];
      for (const imageName of probeImages) {
        for (const cliName of PROBE_CLIS) {
          try {
            await getCliXml(imageName, cliName);
            probed.push({ imageName, cliName });
          } catch (e) {
            console.log(`[NucleiModal] probe failed: ${imageName}/${cliName} →`, e?.response?.status, e?.message);
          }
        }
      }
      console.log('[NucleiModal] probe result:', probed);
      setClis(probed);
      if (probed.length === 1) setSelected(probed[0]);
      setLoadingClis(false);
    }

    load();
  }, []);

  // Poll job status
  const pollJob = useCallback((jobId) => {
    const iv = setInterval(async () => {
      try {
        const job = await getJob(jobId);
        setJobStatus(job);
        if (job.status === 3) {
          clearInterval(iv);
          setStep('done');
          qc.invalidateQueries({ queryKey: ['annotations', item?._id] });
        } else if (job.status === 4 || job.status === 5) {
          clearInterval(iv);
          setStep('error');
          const lastLog = job.log?.slice(-1)[0] || '';
          setErrorMsg(`Job ${STATUS_LABELS[job.status]}: ${lastLog || '(no details)'}`);
        }
      } catch (e) {
        clearInterval(iv);
        setStep('error');
        setErrorMsg(e?.message || 'Polling failed');
      }
    }, 2500);
    return () => clearInterval(iv);
  }, [qc, item]);

  const handleRun = async () => {
    if (!selected) return;
    setStep('running');
    setErrorMsg('');
    setJobStatus(null);
    try {
      // Fetch CLI XML to understand parameter names.
      // Prefer the xmlspec URL Girder gave us; fall back to constructing it.
      let cliParams = {};
      try {
        const xml = selected.xmlUrl
          ? await getCliXmlByPath(selected.xmlUrl)
          : await getCliXml(selected.imageName, selected.cliName);
        cliParams = parseCliXml(xml);
      } catch (_) {
        // If XML fetch fails, use HistomicsTK NucleiDetection param names as fallback
        cliParams = { inputImage: 'inputImageFile', outputFile: 'outputNucleiAnnotationFile', roiParam: 'analysis_roi' };
      }

      // Slicer CLI Web validates the input image param as a file ID, not item ID.
      // Fetch the item's files and use the first file's _id.
      let fileId = null;
      try {
        const files = await getItemFiles(item._id);
        fileId = files?.[0]?._id || null;
      } catch (_) {}

      const params = buildJobParams(cliParams, item, bbox, fileId);
      console.log('[NucleiModal] submitting job params:', params);

      // Prefer the run URL Girder gave us; fall back to constructing it.
      const job = selected.runUrl
        ? await runCliByPath(selected.runUrl, params)
        : await runCliJob(selected.imageName, selected.cliName, params);

      if (!job?._id) throw new Error('No job ID returned');
      setJobStatus(job);
      pollJob(job._id);
    } catch (e) {
      setStep('error');
      const serverMsg = e?.response?.data?.message || e?.response?.data;
      const detail = typeof serverMsg === 'string' ? serverMsg : JSON.stringify(serverMsg);
      console.error('[NucleiModal] job error:', e?.response?.status, e?.response?.data, e?.message);
      setErrorMsg(detail || e?.message || 'Job submission failed');
    }
  };

  const progress = jobStatus?.progress;
  const pct = progress?.current && progress?.total
    ? Math.round((progress.current / progress.total) * 100)
    : null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}>
      <div className="rounded-xl w-[420px] mx-4" style={{ background: '#13151f', border: '1px solid rgba(255,255,255,0.1)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2">
              <circle cx="12" cy="12" r="4"/><circle cx="12" cy="5" r="1" fill="#4caf82"/>
              <circle cx="12" cy="19" r="1" fill="#4caf82"/>
              <circle cx="5" cy="8" r="1" fill="#4caf82"/><circle cx="19" cy="8" r="1" fill="#4caf82"/>
              <circle cx="5" cy="16" r="1" fill="#4caf82"/><circle cx="19" cy="16" r="1" fill="#4caf82"/>
            </svg>
            <span className="text-sm font-semibold text-white">Annotate Nuclei</span>
          </div>
          {step !== 'running' && (
            <button onClick={onClose} className="text-gray-600 hover:text-white">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        <div className="p-4 space-y-3">

          {/* ROI info */}
          <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(76,175,130,0.08)', border: '1px solid rgba(76,175,130,0.2)' }}>
            <div className="text-gray-400 mb-1">Region of Interest</div>
            <div className="font-semibold text-gray-200 truncate">{ann.annotation?.name || 'Selected annotation'}</div>
            {bbox ? (
              <div className="text-gray-500 font-mono mt-0.5">
                {bbox.width} × {bbox.height} px &nbsp;at ({bbox.x}, {bbox.y})
              </div>
            ) : (
              <div className="text-yellow-600 mt-0.5">Could not compute bounding box from elements</div>
            )}
          </div>

          {/* CLI selection */}
          {step === 'select' && (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1.5">Detection Algorithm (Slicer CLI)</label>
                {loadingClis ? (
                  <div className="flex items-center gap-2 py-2">
                    <div className="spinner" style={{ width: 12, height: 12 }}/>
                    <span className="text-xs text-gray-600">Loading available CLIs…</span>
                  </div>
                ) : clis.length === 0 ? (
                  <div className="text-xs rounded-lg p-3" style={{ background: 'rgba(233,69,96,0.08)', border: '1px solid rgba(233,69,96,0.2)', color: '#e94560' }}>
                    No nuclei detection CLIs found in Girder.
                    {rawApiInfo && <div className="font-mono text-yellow-600 mt-1 text-xs break-all">{rawApiInfo}</div>}
                    <div className="text-gray-500 mt-1">
                      Install a nuclei detection Docker image (e.g. HistomicsTK, HoVer-Net, StarDist) via the Girder admin panel.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {clis.map((c, i) => (
                      <button key={i}
                        onClick={() => setSelected(c)}
                        className="w-full text-left px-3 py-2 rounded-lg text-xs transition-colors"
                        style={{
                          background: selected?.cliName === c.cliName && selected?.imageName === c.imageName
                            ? 'rgba(76,175,130,0.15)' : 'rgba(255,255,255,0.04)',
                          border: selected?.cliName === c.cliName && selected?.imageName === c.imageName
                            ? '1px solid rgba(76,175,130,0.3)' : '1px solid rgba(255,255,255,0.06)',
                          color: '#d1d5db',
                        }}>
                        <div className="font-semibold">{c.cliName}</div>
                        <div className="text-gray-600 text-xs truncate">{c.imageName}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {clis.length === 0 && (
                <div className="text-xs text-gray-600 px-1">
                  Tip: For lymphoma nuclei detection, consider installing{' '}
                  <span className="font-mono text-gray-400">dsarchive/histomicstk</span> or{' '}
                  <span className="font-mono text-gray-400">nadeemlab/deepliif</span>.
                </div>
              )}
            </>
          )}

          {/* Running state */}
          {step === 'running' && (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-3">
                <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2, borderTopColor: '#4caf82', flexShrink: 0 }}/>
                <div className="text-xs text-gray-400">
                  {jobStatus
                    ? (pct != null ? `Processing… ${pct}%` : `${STATUS_LABELS[jobStatus.status] || 'Working'}…`)
                    : 'Submitting job…'}
                </div>
              </div>
              {pct != null && (
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: '#4caf82' }}/>
                </div>
              )}
              {jobStatus?._id && (
                <div className="text-xs text-gray-700 font-mono">Job ID: {jobStatus._id.slice(-8)}</div>
              )}
            </div>
          )}

          {/* Done */}
          {step === 'done' && (
            <div className="rounded-lg p-3 text-xs flex items-start gap-2" style={{ background: 'rgba(76,175,130,0.1)', border: '1px solid rgba(76,175,130,0.25)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4caf82" strokeWidth="2" className="shrink-0 mt-0.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <div>
                <div className="font-semibold text-green-400">Detection complete</div>
                <div className="text-gray-500 mt-0.5">Nuclei annotations have been added to the slide. The annotations panel will refresh automatically.</div>
              </div>
            </div>
          )}

          {/* Error */}
          {step === 'error' && (
            <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(233,69,96,0.08)', border: '1px solid rgba(233,69,96,0.2)' }}>
              <div className="font-semibold text-red-400 mb-1">Job failed</div>
              <div className="text-gray-500 font-mono break-all">{errorMsg}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 flex gap-2 justify-end" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          {(step === 'select' || step === 'error') && (
            <>
              <button onClick={onClose} className="btn-ghost text-xs px-3">Cancel</button>
              {step === 'select' && (
                <button
                  onClick={handleRun}
                  disabled={!selected || !bbox}
                  className="text-xs px-4 py-1.5 rounded transition-all disabled:opacity-40"
                  style={{ background: 'rgba(76,175,130,0.15)', color: '#4caf82', border: '1px solid rgba(76,175,130,0.3)' }}>
                  Run Detection
                </button>
              )}
              {step === 'error' && (
                <button
                  onClick={() => { setStep('select'); setErrorMsg(''); }}
                  className="text-xs px-4 py-1.5 rounded transition-all"
                  style={{ background: 'rgba(245,166,35,0.15)', color: '#f5a623', border: '1px solid rgba(245,166,35,0.3)' }}>
                  Try Again
                </button>
              )}
            </>
          )}
          {step === 'done' && (
            <button onClick={onClose}
              className="text-xs px-4 py-1.5 rounded transition-all"
              style={{ background: 'rgba(76,175,130,0.15)', color: '#4caf82', border: '1px solid rgba(76,175,130,0.3)' }}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
