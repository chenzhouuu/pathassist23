// src/components/panels/MetadataPanel.jsx
import React from 'react';
import { useStore } from '../../store/index.js';
import { useQuery } from '@tanstack/react-query';
import { getItem } from '../../api/index.js';
import { getThumbnailUrl } from '../../api/index.js';

function Row({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <tr>
      <td className="text-gray-500 py-1 pr-3 font-mono text-xs whitespace-nowrap align-top">{label}</td>
      <td className="text-gray-200 py-1 text-xs break-all">{String(value)}</td>
    </tr>
  );
}

export default function MetadataPanel() {
  const { activeItem, tilesInfo } = useStore();

  const { data: item } = useQuery({
    queryKey: ['item', activeItem?._id],
    queryFn: () => getItem(activeItem._id),
    enabled: !!activeItem?._id,
  });

  if (!activeItem) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-gray-600 text-xs gap-2">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
        </svg>
        No slide selected
      </div>
    );
  }

  const thumbUrl = getThumbnailUrl(activeItem._id);
  const meta = item?.meta || {};

  return (
    <div className="p-3">
      {/* Thumbnail */}
      <div className="mb-3 rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <img
          src={thumbUrl}
          alt="Slide thumbnail"
          className="w-full object-contain"
          style={{ maxHeight: 160, background: '#000' }}
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      </div>

      {/* Slide name */}
      <div className="mb-3">
        <div className="text-xs text-gray-500 mb-1">Slide Name</div>
        <div className="text-sm text-white font-medium break-all">{activeItem.name}</div>
      </div>

      {/* Tile info */}
      {tilesInfo && (
        <div className="mb-3">
          <div className="panel-header px-0 mb-2" style={{ border: 'none' }}>Image Info</div>
          <table className="meta-table w-full">
            <tbody>
              <Row label="Width" value={tilesInfo.sizeX ? `${tilesInfo.sizeX.toLocaleString()} px` : null} />
              <Row label="Height" value={tilesInfo.sizeY ? `${tilesInfo.sizeY.toLocaleString()} px` : null} />
              <Row label="Magnification" value={tilesInfo.magnification ? `${tilesInfo.magnification}×` : null} />
              <Row label="Tile Size" value={tilesInfo.tileWidth ? `${tilesInfo.tileWidth} × ${tilesInfo.tileHeight}` : null} />
              <Row label="Levels" value={tilesInfo.levels} />
              <Row label="μm/px (X)" value={tilesInfo.mm_x ? `${(tilesInfo.mm_x * 1000).toFixed(4)}` : null} />
              <Row label="μm/px (Y)" value={tilesInfo.mm_y ? `${(tilesInfo.mm_y * 1000).toFixed(4)}` : null} />
              <Row label="Format" value={tilesInfo.tilesource} />
            </tbody>
          </table>
        </div>
      )}

      {/* Item metadata */}
      {item && (
        <div className="mb-3">
          <div className="panel-header px-0 mb-2" style={{ border: 'none' }}>File Info</div>
          <table className="meta-table w-full">
            <tbody>
              <Row label="ID" value={item._id} />
              <Row label="Size" value={item.size ? `${(item.size / 1024 / 1024).toFixed(2)} MB` : null} />
              <Row label="Created" value={item.created ? new Date(item.created).toLocaleDateString() : null} />
              <Row label="Updated" value={item.updated ? new Date(item.updated).toLocaleDateString() : null} />
            </tbody>
          </table>
        </div>
      )}

      {/* Custom meta */}
      {Object.keys(meta).length > 0 && (
        <div>
          <div className="panel-header px-0 mb-2" style={{ border: 'none' }}>Custom Metadata</div>
          <table className="meta-table w-full">
            <tbody>
              {Object.entries(meta).map(([k, v]) => (
                <Row key={k} label={k} value={typeof v === 'object' ? JSON.stringify(v) : v} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
