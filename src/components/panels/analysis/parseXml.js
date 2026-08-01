// src/components/panels/analysis/parseXml.js — Slicer CLI XML → the shape the form renderer reads.
//
// Moved out of AnalysisPanel unchanged (Inc 6 · 02). It earns its own file because it is now one of
// *two* producers of that shape — `nativeCatalog.js` is the other, declaring the same structure as
// data instead of parsing it out of XML — and because a pure string→object function is the part of
// the catalog worth testing directly.

/** Parse a Slicer CLI XML spec into `{ title, description, category, groups }`. */
export function parseXml(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const get = (sel) => doc.querySelector(sel)?.textContent?.trim() || '';
  const groups = [];
  doc.querySelectorAll('executable > parameters').forEach(grp => {
    const label = grp.querySelector(':scope > label')?.textContent?.trim() || '';
    const params = [];
    for (const el of grp.children) {
      const tag = el.tagName;
      if (['label', 'description'].includes(tag)) continue;
      const name = el.querySelector('name')?.textContent?.trim();
      if (!name) continue;
      const channel = el.querySelector('channel')?.textContent?.trim();
      const defVal = el.querySelector('default')?.textContent?.trim() ?? '';
      const enums = Array.from(el.querySelectorAll('enumeration')).map(e => e.textContent.trim());
      const cons = el.querySelector('constraints');
      params.push({
        tag,
        name,
        label: el.querySelector('label')?.textContent?.trim() || name,
        desc: el.querySelector('description')?.textContent?.trim() || '',
        channel,
        defVal,
        enums,
        min: cons?.querySelector('minimum')?.textContent?.trim(),
        max: cons?.querySelector('maximum')?.textContent?.trim(),
        step: cons?.querySelector('step')?.textContent?.trim(),
        index: el.querySelector('index')?.textContent?.trim(),
        // Attributes, not elements. `fileExtensions` names what an output file should be called;
        // slicer_cli_web's own parser reads both off the element (parser/param.js:32-35).
        fileExtensions: el.getAttribute('fileExtensions') || '',
        reference: el.getAttribute('reference') || '',
      });
    }
    if (params.length) groups.push({ label, params });
  });
  return {
    title: get('executable > title'),
    description: get('executable > description'),
    category: get('executable > category'),
    groups,
  };
}

/** Whether a CLI param is filled in from the active slide and hidden from the user. */
export function isAutoFilled(p) {
  // image/file inputs are prefilled with active slide; outputs with folder.
  // float-vector (ROI) and region are shown to the user so they can set coordinates.
  return ['image', 'file', 'new-file', 'item', 'directory'].includes(p.tag);
}
