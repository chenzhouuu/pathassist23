// src/components/panels/AnalysisPanel.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import { useQuery } from '@tanstack/react-query';
import { getDockerImages, getJobs } from '../../api/index.js';

const STATUS_COLORS = {
  success: '#4caf82',
  error: '#e94560',
  running: '#4da6ff',
  queued: '#f5a623',
  inactive: '#6b7280',
};

const STATUS_ICONS = {
  success: '✓',
  error: '✗',
  running: '↻',
  queued: '…',
  inactive: '—',
};

export default function AnalysisPanel() {
  const { activeItem } = useStore();

  const { data: images, isLoading: loadingImages } = useQuery({
    queryKey: ['docker-images'],
    queryFn: getDockerImages,
    retry: 1,
  });

  const { data: jobs, isLoading: loadingJobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: getJobs,
    refetchInterval: 5000,
    retry: 1,
  });

  return (
    <div className="p-3">
      {/* Available tasks */}
      <div className="mb-4">
        <div className="panel-header px-0 mb-2" style={{ border: 'none' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          Available Tasks (Docker)
        </div>

        {loadingImages && <div className="flex justify-center py-3"><div className="spinner" /></div>}

        {!loadingImages && (!images || Object.keys(images).length === 0) && (
          <div className="text-xs text-gray-600 py-3 text-center">
            No Docker tasks available.<br />
            <span className="text-gray-700">Admin: add via Slicer CLI Web settings</span>
          </div>
        )}

        {images && Object.entries(images).map(([imgName, clis]) => (
          <div key={imgName} className="mb-2">
            <div className="text-xs text-gray-500 font-mono mb-1 truncate px-1">{imgName}</div>
            {Array.isArray(clis) && clis.map((cli) => (
              <div key={cli.name}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer transition-colors group">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                <span className="text-xs text-gray-300 flex-1">{cli.title || cli.name}</span>
                <button
                  className="opacity-0 group-hover:opacity-100 px-2 py-0.5 rounded text-xs transition-all"
                  style={{ background: 'rgba(77,166,255,0.15)', color: '#4da6ff' }}
                  title={`Run ${cli.name} on current slide`}
                  onClick={() => alert(`To run ${cli.name}: implement task parameter form connecting to POST /slicer_cli_web/${imgName}/${cli.name}/run`)}
                >
                  Run
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Recent jobs */}
      <div>
        <div className="panel-header px-0 mb-2" style={{ border: 'none' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          Recent Jobs
          {loadingJobs && <div className="ml-auto spinner" style={{ width: 10, height: 10 }} />}
        </div>

        {!loadingJobs && (!jobs || jobs.length === 0) && (
          <div className="text-xs text-gray-600 text-center py-3">No jobs found</div>
        )}

        {jobs?.map((job) => {
          const status = job.status === 3 ? 'success' : job.status === 4 ? 'error' : job.status === 2 ? 'running' : job.status === 1 ? 'queued' : 'inactive';
          const color = STATUS_COLORS[status];
          return (
            <div key={job._id} className="flex items-start gap-2 py-1.5 px-1 rounded hover:bg-white/3 transition-colors">
              <span className="text-xs font-mono mt-0.5" style={{ color, flexShrink: 0 }}>
                {STATUS_ICONS[status]}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-300 truncate">{job.title || job.type}</div>
                <div className="text-xs text-gray-600">{new Date(job.created).toLocaleString()}</div>
                {status === 'running' && (
                  <div className="mt-1 h-1 rounded overflow-hidden" style={{ background: 'var(--border)' }}>
                    <div className="h-full rounded animate-pulse" style={{ background: color, width: `${job.progress?.current || 50}%` }} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
