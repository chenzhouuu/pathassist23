// The Slicer CLI /run body (Inc 6 · 02). Every assertion here is a rule read off the installed
// `slicer_cli_web`, and every one of them was being broken: the panel sent the item id where a
// file id was required, and the output folder id where the output *name* goes. On the DEMO slide
// that was `400 Invalid file id`, then `KeyError: 'outputAnnotationFile_folder'`.
import { describe, expect, it } from 'vitest';
import { cliRunParams, isNewFile, outputName } from './cliParams.js';

// The DEMO slide as Girder returns it. `largeImage.fileId` is deliberately *not* a file in this
// item's own file list: it is a copyOfItem, and upstream still prefers this field.
const ITEM = {
  _id: '6a6e1ca82ae96ce927e33818',
  name: 'TCGA-WT-AB44-01A-01-TS1.B6C0EEDB.svs',
  folderId: '6a6e1ca82ae96ce927e33817',
  largeImage: { fileId: '6a3d59c8d59c30f37fd99be0', sourceName: 'openslide' },
};
const NOW = new Date('2026-08-01T19:44:56.000Z');

// Compute Background Intensity, as the deployment actually serves it.
const GROUPS = [{
  label: 'IO',
  params: [
    { tag: 'image', name: 'slide_path', label: 'Input Image', channel: 'input', index: '0', defVal: '' },
    { tag: 'float', name: 'sample_fraction', label: 'Sample Fraction', defVal: '0.1' },
    { tag: 'integer', name: 'sample_approximate_total', label: 'Total', defVal: '-1' },
    { tag: 'file', name: 'outputAnnotationFile', label: 'Output Annotation File',
      channel: 'output', index: '1', defVal: '', fileExtensions: '.anot|.json' },
  ],
}];

describe('an image input is a file id', () => {
  it('prefers largeImage.fileId, which is what ItemSelectorWidget resolves to', () => {
    const p = cliRunParams({ groups: GROUPS, values: {}, item: ITEM, cliName: 'bg', now: NOW });
    expect(p.slide_path).toBe(ITEM.largeImage.fileId);
    expect(p.slide_path).not.toBe(ITEM._id);
  });

  it('falls back to the item id for a slide with no large_image record', () => {
    const p = cliRunParams({
      groups: GROUPS, values: {}, item: { ...ITEM, largeImage: undefined }, now: NOW,
    });
    expect(p.slide_path).toBe(ITEM._id);
  });
});

describe('an output file is a name plus a folder', () => {
  it('classifies a <file channel="output"> as a new-file, per parser/param.js', () => {
    expect(isNewFile({ tag: 'file', channel: 'output' })).toBe(true);
    expect(isNewFile({ tag: 'image', channel: 'output' })).toBe(true);
    expect(isNewFile({ tag: 'file', channel: 'input' })).toBe(false);
    expect(isNewFile({ tag: 'string', channel: 'output' })).toBe(false);
  });

  it('sends the companion _folder the server reads unguarded', () => {
    const p = cliRunParams({ groups: GROUPS, values: {}, item: ITEM, cliName: 'bg', now: NOW });
    expect(p.outputAnnotationFile_folder).toBe(ITEM.folderId);
  });

  it('names the output after the slide, the CLI and the moment — not the folder id', () => {
    const p = cliRunParams({ groups: GROUPS, values: {}, item: ITEM, cliName: 'bg', now: NOW });
    expect(p.outputAnnotationFile).not.toBe(ITEM.folderId);
    expect(p.outputAnnotationFile).toBe(
      'TCGA-WT-AB44-01A-01-TS1.B6C0EEDB-bg-Output Annotation File-2026-08-01T19-44-56-000.anot',
    );
  });

  it('takes the first of several declared extensions, and copes with none', () => {
    expect(outputName({ name: 'o', label: 'O', fileExtensions: '.anot|.json' },
      { slideName: 's.svs', cliName: 'c', now: NOW })).toMatch(/\.anot$/);
    expect(outputName({ name: 'o', label: 'O' },
      { slideName: 's.svs', cliName: 'c', now: NOW })).toMatch(/-2026-08-01T19-44-56-000$/);
  });
});

describe('everything else', () => {
  it('carries the user\'s value, and the declared default when the field is untouched', () => {
    const p = cliRunParams({
      groups: GROUPS, values: { sample_fraction: '0.25' }, item: ITEM, now: NOW,
    });
    expect(p.sample_fraction).toBe('0.25');
    expect(p.sample_approximate_total).toBe('-1');
  });

  it('maps the remaining external tags the way WidgetCollection does', () => {
    const groups = [{
      label: 'x',
      params: [
        { tag: 'item', name: 'anItem', label: 'Item', channel: 'input' },
        { tag: 'directory', name: 'aDir', label: 'Dir', channel: 'input' },
      ],
    }];
    const p = cliRunParams({ groups, values: {}, item: ITEM, now: NOW });
    expect(p.anItem).toBe(ITEM._id);
    expect(p.aDir).toBe(ITEM.folderId);
  });
});
