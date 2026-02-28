// src/components/panels/AnnotationsPanel.jsx
import React, { useState } from 'react';
import { useStore } from '../../store/index.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnnotations, deleteAnnotation } from '../../api/index.js';

const COLORS = ['#e94560', '#4da6ff', '#4caf82', '#f5a623', '#c27aff', '#ff6b6b', '#00bcd4'];

export default function AnnotationsPanel() {
  const {
    activeItem, annotations, setAnnotations,
    visibleAnnotations, toggleAnnotationVisibility,
    selectedAnnotation, setSelectedAnnotation,
    drawingMode, setDrawingMode
  } = useStore();
  const qc = useQueryClient();

  const { isLoading } = useQuery({
    queryKey: ['annotations', activeItem?._id],
    queryFn: () => getAnnotations(activeItem._id),
    enabled: !!activeItem?._id,
    onSuccess: setAnnotations,
  });

  const handleDelete = async (ann) => {
    if (!confirm(`Delete annotation "${ann.annotation?.name || 'Untitled'}"?`)) return;
    try {
      await deleteAnnotation(ann._id);
      qc.invalidateQueries(['annotations', activeItem._id]);
    } catch (err) {
      alert('Failed to delete annotation');
    }
  };

  if (!activeItem) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-gray-600 text-xs gap-2">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        No slide selected
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Draw toolbar */}
      <div className="p-2 flex flex-wrap gap-1" style={{ borderBottom: '1px solid var(--border)' }}>
        {['point', 'rectangle', 'polygon', 'polyline'].map((mode) => (
          <button
            key={mode}
            onClick={() => setDrawingMode(drawingMode === mode ? null : mode)}
            className={`px-2 py-1 rounded text-xs transition-colors font-medium ${
              drawingMode === mode
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
          >
            + {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      {/* Header */}
      <div className="panel-header flex-shrink-0">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        Annotations
        <span className="ml-auto text-gray-600 font-normal normal-case">{annotations.length}</span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex justify-center py-6"><div className="spinner" /></div>
        )}

        {!isLoading && annotations.length === 0 && (
          <div className="text-xs text-gray-600 text-center py-6">
            No annotations. Use drawing tools above to create one.
          </div>
        )}

        {annotations.map((ann, i) => {
          const name = ann.annotation?.name || `Annotation ${i + 1}`;
          const elCount = ann.annotation?.elements?.length || 0;
          const color = COLORS[i % COLORS.length];
          const isVisible = visibleAnnotations[ann._id] !== false;
          const isSelected = selectedAnnotation?._id === ann._id;

          return (
            <div
              key={ann._id}
              className={`ann-row ${isSelected ? 'selected' : ''}`}
              onClick={() => setSelectedAnnotation(isSelected ? null : ann)}
            >
              {/* Color dot */}
              <span className="color-swatch flex-shrink-0" style={{ background: color }} />

              {/* Name & count */}
              <div className="flex-1 min-w-0">
                <div className="truncate text-xs text-gray-200">{name}</div>
                <div className="text-xs text-gray-600">{elCount} element{elCount !== 1 ? 's' : ''}</div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn-icon"
                  onClick={() => toggleAnnotationVisibility(ann._id)}
                  title={isVisible ? 'Hide' : 'Show'}
                >
                  {isVisible ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>
                <button
                  className="btn-icon text-red-500 hover:text-red-400"
                  onClick={() => handleDelete(ann)}
                  title="Delete"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Selected annotation details */}
      {selectedAnnotation && (
        <div className="p-3 text-xs" style={{ borderTop: '1px solid var(--border)', background: 'var(--highlight)' }}>
          <div className="text-gray-400 font-semibold mb-1">
            {selectedAnnotation.annotation?.name || 'Untitled'}
          </div>
          <div className="text-gray-600">ID: <span className="font-mono text-gray-500">{selectedAnnotation._id}</span></div>
          {selectedAnnotation.annotation?.description && (
            <div className="text-gray-500 mt-1">{selectedAnnotation.annotation.description}</div>
          )}
        </div>
      )}
    </div>
  );
}
