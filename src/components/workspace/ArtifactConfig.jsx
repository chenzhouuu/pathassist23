// src/components/workspace/ArtifactConfig.jsx — the controls an artifact's layer is drawn with.
//
// Modelled on OHIF's platform/ui-next/src/components/SegmentationTable/SegmentationTableConfig.tsx
// at v3.10.0-beta.151 (4e09f85d5), and deliberately **not** a verbatim copy of it. What was kept
// and what was not:
//
//   Kept, to the class string: the `bg-muted rounded-b px-1.5 pt-0.5 pb-3 space-y-2` block; the
//   control row `Label w-14 flex-none · Slider mx-1 flex-1 · value w-10 flex-none`; the
//   `Tabs / TabsList / TabsTrigger` segmented control and its `text-aqua-pale text-xs` caption.
//   Both primitives are vendored verbatim (ui/slider.tsx, ui/tabs.tsx) from the same tag.
//
//   Dropped: `useSegmentationTableContext`, and with it every control that reads it. Upstream's
//   fill/outline tabs, Border width and "display inactive segmentations" describe a Cornerstone
//   labelmap representation. Our layer is a raster tile pyramid with an alpha and a choice of two
//   lookups — it has no outline to widen and no inactive sibling to show. Vendoring the file and
//   feeding it a context of look-alike names would have put three tab icons and a Border slider in
//   front of a pathologist, none of which do anything. The controls are ours; the shape is theirs.
//
//   Substituted: upstream's fill/outline segmented control becomes the render-mode one, which is
//   the same widget answering the question this layer actually has.
//
// Nothing here owns state. The parameters live in the store (they outlive this panel, because the
// mask keeps drawing while the Workspace is closed); this edits them.
import React from 'react';
import { Slider } from '../ui/slider.tsx';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.tsx';

export default function ArtifactConfig({ config, onMode, onOpacity }) {
  if (!config?.drawn) return null;

  return (
    <div className="bg-muted mb-0.5 space-y-2 rounded-b px-1.5 pt-0.5 pb-3" data-cy="artifact-config">
      {config.modes.length > 0 && (
        <div className="my-1 flex items-center justify-between">
          <span className="text-aqua-pale text-xs">Colour by</span>
          <Tabs value={config.mode} onValueChange={onMode}>
            <TabsList>
              {config.modes.map(m => (
                <TabsTrigger key={m.value} value={m.value} className="text-xs">
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      <div className="my-2 flex items-center">
        <label className="text-muted-foreground w-14 flex-none whitespace-nowrap text-xs"
          htmlFor="artifact-opacity">
          Opacity
        </label>
        <Slider
          id="artifact-opacity"
          className="mx-1 flex-1"
          value={[config.opacity]}
          onValueChange={([v]) => onOpacity(v)}
          // 0.05 rather than upstream's 0 : a layer at zero alpha is indistinguishable from one
          // switched off, and the eye on the row above already means that.
          min={0.05}
          max={1}
          step={0.05}
        />
        <span className="text-muted-foreground mx-1 w-10 flex-none text-center text-xs"
          data-cy="opacity-value">
          {config.opacity.toFixed(2)}
        </span>
      </div>

      {config.note && (
        <div className="text-muted-foreground px-1 text-xs leading-snug">{config.note}</div>
      )}
    </div>
  );
}
