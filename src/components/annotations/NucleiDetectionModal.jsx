// src/components/annotations/NucleiDetectionModal.jsx
// Submit a Slicer CLI nuclei detection job for a selected ROI annotation.
import React, { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getDockerImages, getCliXml, runCliJob, getJob } from '../../api/index.js';
import { getAnnotationBBox } from './annotationUtils.js';

// Parse Slicer CLI XML → extract parameter names by element type
function parseCliXml(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const params = {};
    const find = (tag) => doc.querySelector(tag)?.querySelector('name')?.textContent?.trim();
    // Common tags for image input, output file, and region
    params.inputImage  = find('image') || find('item') || find('file');
    params.outputFile  = find('new-file') || find('file-out');
    params.roiParam    = find('region') || find('roi');
    params.title       = doc.querySelector('title')?.textContent?.trim() || '';
    params.description = doc.querySelector('description')?.textContent?.trim() || '';
    return params;
  } catch (_) {
    return {};
  }
}

// Build the params object for POST /slicer_cli_web/.../run
function buildJobParams(cliParams, item, bbox) {
  const params = {};
  const itemRef  = JSON.stringify({ _id: item._id, _modelType: 'item' });
  const folderRef = JSON.stringify({ _id: item.folderId, _modelType: 'folder' });
  const roiStr    = bbox ? `${bbox.x},${bbox.y},${bbox.width},${bbox.height}` : '-1,-1,-1,-1';

  if (cliParams.inputImage)  params[cliParams.inputImage]  = itemRef;
  if (cliParams.outputFile)  params[cliParams.outputFile]  = folderRef;
  if (cliParams.roiParam)    params[cliParams.roiParam]    = roiStr;

  // Always include these common Slicer CLI girder params
  params['girderApiUrl']   = window.location.origin + '/api/v1';
  params['girderToken']    = localStorage.getItem('girderToken') || '';
  return params;
}

// Flatten docker image list into { imageName, cliName } pairs filtered by nuclei-related names
function extractNucleiClis(images) {
  const pattern = /nucle|cell|detect|segment|hover|stardist|deepliif/i;
  const all = [];

  if (Array.isArray(images)) {
    // Array format: [{ image, tag, CLIList }, ...]
    images.forEach(img => {
      const imgName = img.image || img.name || String(img);
      const tag     = img.tag ? `:${img.tag}` : '';
      const fullName = tag ? `${imgName}${tag}` : imgName;
      const cliList  = img.CLIList || img.cliList || {};
      Object.keys(cliList).forEach(cliName => {
        if (pattern.test(cliName) || pattern.test(imgName)) {
          all.push({ imageName: fullName, cliName });
        }
      });
    });
  } else if (images && typeof images === 'object') {
    // Object format: { "imageName": { "tag": { CLIList: {...} } } }
    Object.keys(images).forEach(imageName => {
      const tags = images[imageName];
      Object.keys(tags || {}).forEach(tag => {
        const entry   = tags[tag];
        const cliList = entry?.CLIList || entry?.cliList || {};
        const fullName = `${imageName}:${tag}`;
        Object.keys(cliList).forEach(cliName => {
          if (pattern.test(cliName) || pattern.test(imageName)) {
            all.push({ imageName: fullName, cliName });
          }
        });
      });
    });
  }

  console.debug('[NucleiModal] extracted CLIs:', all);
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

  // Load available CLIs
  useEffect(() => {
    getDockerImages()
      .then(images => {
        console.log('[NucleiModal] raw docker images response:', JSON.stringify(images, null, 2));
        const filtered = extractNucleiClis(images);
        setClis(filtered);
        if (filtered.length === 1) setSelected(filtered[0]);
      })
      .catch(e => console.error('[NucleiModal] Failed to load CLIs:', e))
      .finally(() => setLoadingClis(false));
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
      // Fetch CLI XML to understand parameter names
      let cliParams = {};
      try {
        const xml = await getCliXml(selected.imageName, selected.cliName);
        cliParams = parseCliXml(xml);
      } catch (_) {
        // If XML fetch fails, use fallback common parameter names
        cliParams = { inputImage: 'inputImageFile', outputFile: 'outputAnnotationFile', roiParam: 'analysis_roi' };
      }

      const params = buildJobParams(cliParams, item, bbox);
      const job = await runCliJob(selected.imageName, selected.cliName, params);
      if (!job?._id) throw new Error('No job ID returned');
      setJobStatus(job);
      pollJob(job._id);
    } catch (e) {
      setStep('error');
      setErrorMsg(e?.response?.data?.message || e?.message || 'Job submission failed');
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
