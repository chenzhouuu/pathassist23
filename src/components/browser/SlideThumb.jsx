// src/components/browser/SlideThumb.jsx
// A slide thumbnail that does not fetch until it is on screen.
//
// This matters more here than it does for an ordinary image list. Girder generates a WSI
// thumbnail by decoding a region out of the pyramid, and on a folder whose thumbnails have never
// been warmed that decode is expensive enough that `prewarmThumbnails` in src/api/index.js walks
// a folder SERIALLY with a 200 ms pause and a two-minute per-item timeout. Rendering fifty <img>
// at once would ask the server for fifty concurrent decodes; an IntersectionObserver keeps the
// count to what the user can actually see.
//
// The observer is exported as `useOnScreen` because the Scan column needs exactly the same gate
// for exactly the same reason — one request per row, held back until the row is worth it — and a
// second copy of twelve lines of IntersectionObserver would be two places to get the rootMargin
// wrong.
//
// The image *contains* rather than covers. Slides in this instance run from 0.62 : 1 to 4.33 : 1,
// and a crop to the middle square of a long tissue strip destroys the macro shape, which is the
// first thing a pathologist reads off a thumbnail. The sunken bed is what makes the letterboxing
// read as the slide's own proportions rather than as a rendering fault.
import React, { useEffect, useRef, useState } from 'react';
import { getThumbnailUrl } from '../../api/index.js';

/**
 * Latch that flips true the first time the returned ref's element comes near the viewport, and
 * never flips back — a row that has already paid for its request should not pay again on the way
 * back up the list.
 *
 * @returns {[React.RefObject<HTMLElement>, boolean]} the ref to attach, and whether it has been seen.
 */
export function useOnScreen() {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return undefined;
    // rootMargin gives one row of lead time, so a thumbnail is usually decoded by the time a
    // slow scroll reaches it, without speculatively fetching the whole list.
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setSeen(true); },
      { rootMargin: '120px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return [ref, seen];
}

export default function SlideThumb({ itemId, size = 40, className = '' }) {
  const [ref, visible] = useOnScreen();
  const [failed, setFailed] = useState(false);

  // A span rather than a div: this renders inside the name <button>, whose content model is
  // phrasing content, and the folder variant beside it in browserColumns.jsx is already a span.
  return (
    <span
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
    </span>
  );
}
