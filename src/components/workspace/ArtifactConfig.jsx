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
//   labelmap representation. Our layer is a raster tile pyramid with an alpha and a choice of
//   lookups — it has no outline to widen and no inactive sibling to show. Vendoring the file and
//   feeding it a context of look-alike names would have put three tab icons and a Border slider in
//   front of a pathologist, none of which do anything. The controls are ours; the shape is theirs.
//
//   Substituted: upstream's fill/outline segmented control becomes the render-mode one, which is
//   the same widget answering the question this layer actually has.
//
// Inc 6 · 06 widened it. Upstream's config is one fixed form because a labelmap has one fixed set
// of properties; ours has three kinds with genuinely different ones — a confidence ramp, an H&E
// fade, a panel preset, a display transfer function. So the props are a small vocabulary
// (`modes`, `opacity`, `choices`, `toggles`, `sliders`, `actions`) and this file renders it
// without knowing what any entry means. What each kind declares is in `artifactDetail.js`, where
// the reasons live; every control reports back through one `onChange(key, value)`, so adding a
// kind is a table entry rather than another prop.
//
// `actions` are the one entry that is not a layer parameter — an export is a file, not a setting —
// so they report under the reserved key `ACTION` with the declaration as the value. Named rather
// than inferred from the value's shape, so a future action that happens to look like a parameter
// cannot be written into the store by accident.
//
// Nothing here owns state. The parameters live in the store (they outlive this panel, because the
// layer keeps drawing while the Workspace is closed); this edits them.
import React from 'react';
import { Slider } from '../ui/slider.tsx';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.tsx';

/** Upstream's control row: a fixed-width label, the control, a fixed-width readout. */
function Row({ label, name, children, value }) {
  return (
    <div className="my-2 flex items-center">
      <label className="text-muted-foreground w-14 flex-none whitespace-nowrap text-xs"
        htmlFor={`artifact-${name}`}>
        {label}
      </label>
      {children}
      {value !== undefined && (
        <span className="text-muted-foreground mx-1 w-10 flex-none text-center text-xs"
          data-cy={`${name}-value`}>
          {value}
        </span>
      )}
    </div>
  );
}

function ConfigSlider({ name, label, value, min, max, step, onChange }) {
  return (
    <Row label={label} name={name} value={Number(value).toFixed(2)}>
      <Slider
        id={`artifact-${name}`}
        className="mx-1 flex-1"
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min}
        max={max}
        step={step}
      />
    </Row>
  );
}

/** The reserved `onChange` key for a control that does something rather than sets something. */
export const ACTION = 'pa-action';

export default function ArtifactConfig({ config, onChange }) {
  if (!config?.drawn) return null;

  const { modes = [], choices = [], toggles = [], sliders = [], actions = [] } = config;

  return (
    <div className="bg-muted mb-0.5 space-y-2 rounded-b px-1.5 pt-0.5 pb-3" data-cy="artifact-config">
      {modes.length > 0 && (
        <div className="my-1 flex items-center justify-between">
          <span className="text-aqua-pale text-xs">Colour by</span>
          <Tabs value={config.mode} onValueChange={(v) => onChange('mode', v)}>
            <TabsList>
              {modes.map(m => (
                <TabsTrigger key={m.value} value={m.value} className="text-xs">
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {choices.map(c => (
        <Row key={c.key} label={c.label} name={c.key}>
          <select
            id={`artifact-${c.key}`}
            className="mx-1 flex-1 rounded px-1 py-0.5 text-xs"
            style={{ background: 'var(--bg)', border: '1px solid var(--border-hex)',
                     color: 'var(--text)' }}
            value={c.value}
            onChange={(e) => onChange(c.key, e.target.value)}
          >
            {c.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Row>
      ))}

      {config.opacity != null && (
        <ConfigSlider
          name="opacity" label="Opacity" value={config.opacity}
          // 0.05 rather than upstream's 0 : a layer at zero alpha is indistinguishable from one
          // switched off, and the eye on the row above already means that.
          min={0.05} max={1} step={0.05}
          onChange={(v) => onChange('opacity', v)}
        />
      )}

      {toggles.map(t => (
        <label key={t.key} className="my-1 flex items-center gap-2 text-xs"
          style={{ color: 'var(--muted-hex)' }}>
          <input
            type="checkbox" checked={!!t.value}
            onChange={() => onChange(t.key, !t.value)}
            data-cy={`artifact-toggle-${t.key}`}
          />
          {t.label}
        </label>
      ))}

      {sliders.map(s => (
        <ConfigSlider
          key={s.key} name={s.key} label={s.label} value={s.value}
          min={s.min} max={s.max} step={s.step}
          onChange={(v) => onChange(s.key, v)}
        />
      ))}

      {actions.length > 0 && (
        <div className="flex gap-2 px-1 pt-1">
          {actions.map(a => (
            <button
              key={a.key} type="button" className="mk-btn text-xs"
              data-cy={`artifact-action-${a.key}`}
              onClick={() => onChange(ACTION, a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {config.note && (
        <div className="text-muted-foreground px-1 text-xs leading-snug">{config.note}</div>
      )}
    </div>
  );
}
