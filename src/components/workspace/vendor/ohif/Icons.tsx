// NOT a copy — a stand-in.
//
// OHIF's DataRow reaches for `Icons.*`, which upstream resolves to
// platform/ui-next/src/components/Icons: 107 files, 608 KB, of which DataRow uses eight glyphs.
// Rather than vendor the set, this module exports those eight names backed by lucide-react, which
// this repo already depends on. DataRow's JSX is then unedited — it still writes `<Icons.More/>`.
//
// The consequence to know about: these are lucide's shapes, not OHIF's. A screenshot of this panel
// beside OHIF's will differ in the icons and nowhere else. If a later ticket needs visual parity,
// or needs more than a handful of glyphs, replace this file with the real set rather than growing
// the map — the seam is deliberately one file wide.

import React from 'react';
import {
  Eye,
  EyeOff,
  Info,
  Lock,
  MoreVertical,
  Palette,
  Pencil,
  Trash2,
} from 'lucide-react';

type IconProps = React.ComponentProps<typeof Eye>;

// `Hide` is the icon shown when a row IS visible — clicking it hides the row. `Show` is its
// opposite. The names read backwards until you know they name the action, not the state.
export const Icons = {
  Hide: (props: IconProps) => <Eye {...props} />,
  Show: (props: IconProps) => <EyeOff {...props} />,
  Lock: (props: IconProps) => <Lock {...props} />,
  More: (props: IconProps) => <MoreVertical {...props} />,
  Rename: (props: IconProps) => <Pencil {...props} />,
  Delete: (props: IconProps) => <Trash2 {...props} />,
  ColorChange: (props: IconProps) => <Palette {...props} />,
  Info: (props: IconProps) => <Info {...props} />,
};

export default Icons;
