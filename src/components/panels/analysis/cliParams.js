// src/components/panels/analysis/cliParams.js — what a Slicer CLI /run actually wants.
//
// Harvested, not invented. Three files in the installed `slicer_cli_web` define this and the panel
// was guessing at all three:
//
//   parser/param.js:31-35        a <file>/<image> with channel=output is a **new-file** widget;
//                                any other output param is not a widget at all.
//   collections/WidgetCollection.js:17-41
//                                file/item/image/directory  → params[id] = <object id>
//                                new-file/multi             → params[id]           = <name>
//                                                             params[id + '_folder'] = <folderId>
//   views/ItemSelectorWidget.js:247-250
//                                an `image` input resolves to a FILE id, preferring
//                                `largeImage.fileId` — an item id is rejected outright.
//
// What the panel sent instead was the *item* id for every input and the *folder* id as the output
// file's *name*. On this deployment that meant every image-input CLI answered
// `400 Invalid file id`, and the two that got past it died on
// `KeyError: 'outputAnnotationFile_folder'` (prepare_task.py:219). So the CLI path had not been
// working at all, and "unchanged" was not an option worth preserving (Inc 6 · 02).

/** Params whose value comes from the slide rather than from the user, and are hidden from the form. */
const EXTERNAL_TAGS = ['image', 'file', 'new-file', 'item', 'directory'];

/** True when this param is an output file the CLI will upload — parser/param.js:31. */
export function isNewFile(p) {
  const channel = p.channel || 'input';
  return channel === 'output' && ['file', 'image', 'new-file'].includes(p.tag);
}

/**
 * The name an output file gets, in the shape ControlWidget.js:78-100 builds:
 * `<slide>-<cli>-<param>-<timestamp><ext>`, with the slide's own extension dropped.
 */
export function outputName(p, { slideName = '', cliName = '', now = new Date() } = {}) {
  const base = slideName.includes('.') ? slideName.slice(0, slideName.lastIndexOf('.')) : slideName;
  const ext = (p.fileExtensions || '').split('|')[0] || '';
  // Colons are legal in Girder but miserable in a filename, so the timestamp is flattened.
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return [base, cliName, p.label || p.name, stamp].filter(Boolean).join('-') + ext;
}

/**
 * Build the body for `POST .../cli/{id}/run`.
 *
 * `item` is the active slide as Girder returns it — `_id`, `folderId`, `name`, and the
 * `largeImage.fileId` that an image input actually needs.
 */
export function cliRunParams({ groups = [], values = {}, item, cliName = '', now }) {
  const params = {};
  groups.forEach(g => g.params.forEach(p => {
    const channel = p.channel || 'input';

    if (isNewFile(p)) {
      // The name here, the destination beside it. Sending the folder id as the name is what
      // produced a KeyError one call deeper, where the missing `_folder` was read unguarded.
      params[p.name] = outputName(p, { slideName: item?.name, cliName, now });
      params[`${p.name}_folder`] = item?.folderId;
      return;
    }

    if (channel === 'output') {
      // Not a widget upstream (param.js:34) — the CLI writes it into the return parameter file,
      // and naming a folder for it is how `returnparameterfile` is handled by the caller.
      params[p.name] = item?.folderId;
      return;
    }

    if (p.tag === 'image') {
      // A FILE id. `largeImage.fileId` even for a copied item, whose own file list points
      // elsewhere — which is exactly the DEMO slide's situation.
      params[p.name] = item?.largeImage?.fileId || item?._id;
      return;
    }
    if (p.tag === 'file') { params[p.name] = item?.largeImage?.fileId || item?._id; return; }
    if (p.tag === 'item') { params[p.name] = item?._id; return; }
    if (p.tag === 'directory') { params[p.name] = item?.folderId; return; }

    if (EXTERNAL_TAGS.includes(p.tag)) return;

    const val = values[p.name];
    const useVal = (val !== '' && val !== undefined) ? String(val)
      : (p.defVal !== '' && p.defVal !== undefined ? p.defVal : undefined);
    if (useVal !== undefined) params[p.name] = useVal;
  }));
  return params;
}
