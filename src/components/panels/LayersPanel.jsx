import React, { useEffect } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnnotationFull, getAnnotationList } from '../../api/index.js';
import { ANN_COLORS, hexToRgba } from '../annotations/annotationUtils.js';

function LayerRow({ ann, idx, visible, onToggle }) {
  const color = ann.annotation?.elements?.[0]?.lineColor || ANN_COLORS[idx % ANN_COLORS.length];
  const name = ann.annotation?.name || `Annotation ${idx + 1}`;
  const elements = ann.annotation?.elements || [];
  const count = ann.elementCount ?? elements.length;
  const typeSummary = [...new Set(elements.map((el) => el.type === 'polyline' && el.closed ? 'polygon' : el.type))].filter(Boolean).join(', ');
  const isAiRoi = elements.some((el) => el.group === 'ai-roi');

  return (
    <div
      className="viewer-layer-row"
      style={{
        borderColor: hexToRgba(color, visible ? 0.22 : 0.12),
        background: visible ? hexToRgba(color, 0.08) : 'rgba(255,255,255,0.02)',
      }}
    >
      <button
        type="button"
        className="viewer-layer-visibility"
        onClick={() => onToggle(ann._id)}
        title={visible ? 'Hide layer' : 'Show layer'}
        style={{ color }}
      >
        {visible ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
        )}
      </button>
      <span className="viewer-layer-swatch" style={{ background: color }} />
      <div className="viewer-layer-copy">
        <div className="viewer-layer-name">
          {name}
          {isAiRoi && <span className="viewer-layer-badge">AI ROI</span>}
        </div>
        <div className="viewer-layer-meta">
          {count} element{count !== 1 ? 's' : ''}{typeSummary ? ` · ${typeSummary}` : ''}
        </div>
      </div>
    </div>
  );
}

export default function LayersPanel() {
  const {
    activeItem,
    annotations,
    setAnnotations,
    visibleAnnotations,
    toggleAnnotationVisibility,
    showAllAnnotations,
    hideAllAnnotations,
  } = useStore();
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['layer-annotations', activeItem?._id],
    queryFn: async () => {
      const list = await getAnnotationList(activeItem._id);
      return Promise.all(list.map(async (ann) => {
        if ((ann.annotation?.elements || []).length > 0) return ann;
        try {
          return await getAnnotationFull(ann._id);
        } catch {
          return ann;
        }
      }));
    },
    enabled: !!activeItem?._id,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (data) setAnnotations(data);
  }, [data, setAnnotations]);

  if (!activeItem) {
    return (
      <div className="viewer-empty-panel">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 7h18M3 12h18M3 17h18"/>
        </svg>
        <span>Select a slide to inspect layers</span>
      </div>
    );
  }

  return (
    <div className="viewer-layers-panel">
      <div className="viewer-layers-toolbar">
        <span className="viewer-layers-count">{annotations.length} layer{annotations.length !== 1 ? 's' : ''}</span>
        <div className="viewer-layers-actions">
          <button type="button" className="btn-icon" title="Show all" onClick={showAllAnnotations}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
          <button type="button" className="btn-icon" title="Hide all" onClick={hideAllAnnotations}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          </button>
          <button type="button" className="btn-icon" title="Refresh" onClick={() => qc.invalidateQueries({ queryKey: ['layer-annotations', activeItem?._id] })}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="viewer-layers-list">
        {isLoading && (
          <div className="viewer-empty-panel">
            <div className="spinner" style={{ width: 16, height: 16 }} />
            <span>Loading layers…</span>
          </div>
        )}
        {isError && (
          <div className="viewer-empty-panel">
            <span>Failed to load layers</span>
          </div>
        )}
        {!isLoading && !isError && annotations.length === 0 && (
          <div className="viewer-empty-panel">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            <span>No annotation layers yet</span>
          </div>
        )}
        {!isLoading && !isError && annotations.map((ann, idx) => (
          <LayerRow
            key={ann._id}
            ann={ann}
            idx={idx}
            visible={visibleAnnotations[ann._id] !== false}
            onToggle={toggleAnnotationVisibility}
          />
        ))}
      </div>
    </div>
  );
}
