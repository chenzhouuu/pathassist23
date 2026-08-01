// Vendored from the OHIF Viewer — platform/ui-next/src/components/Slider/Slider.tsx
// at OHIF/Viewers v3.10.0-beta.151 (4e09f85d5), MIT License,
// Copyright (c) 2018 Open Health Imaging Foundation.
//
// One edit from upstream: the `cn` import path points at this repo's @/lib/utils. The class
// strings — the 1px track, the 4×4 thumb, the `bg-primary/30` fill — are upstream's, because
// `SegmentationTableConfig` is laid out against exactly these dimensions and a taller slider
// would break the `Label w-14 · Slider flex-1 · value w-10` row it sits in.

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="bg-primary/30 relative h-1 w-full grow overflow-hidden rounded-full">
      <SliderPrimitive.Range className="bg-primary absolute h-full" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="border-background bg-primary focus-visible:ring-ring block h-4 w-4 rounded-full border-2 shadow transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:pointer-events-none disabled:opacity-50" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
