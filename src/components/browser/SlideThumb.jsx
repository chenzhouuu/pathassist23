// src/components/browser/SlideThumb.jsx
// A slide thumbnail that does not fetch until it is on screen.
//
// This matters more here than it does for an ordinary image list. Girder generates a WSI
// thumbnail by decoding a region out of the pyramid, and on a folder whose thumbnails have never
// been warmed that decode is expensive enough that `prewarmThumbnails` in src/api/index.js walks
// a folder SERIALLY with a 200 ms pause and a two-minute per-item timeout. Rendering fifty <img>
// at once would ask the server for fifty concurrent decodes; an IntersectionObserver keeps the
// count to what the user can actually see.
import React, { useEffect, useRef, useState } from 'react';
import { getThumbnailUrl } from '../../api/index.js';

export default function SlideThumb({ itemId, size = 40, className = '' }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return undefined;
    // rootMargin gives one row of lead time, so a thumbnail is usually decoded by the time a
    // slow scroll reaches it, without speculatively fetching the whole list.
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisible(true); },
      { rootMargin: '120px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  return (
    <div
      ref={ref}
      className={`browser-thumb ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {visible && !failed && (
        <img
          src={getThumbnailUrl(itemId)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
