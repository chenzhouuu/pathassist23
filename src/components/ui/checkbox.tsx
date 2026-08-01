// Vendored from the OHIF Viewer — platform/ui-next/src/components/Checkbox/Checkbox.tsx
// at OHIF/Viewers master, MIT License, Copyright (c) 2018 Open Health Imaging Foundation.
//
// Verbatim apart from the `cn` import path, which was repointed at this repo's @/lib/utils.
// These are the shadcn/ui "new-york" primitives with OHIF's adjustments; they are what the
// browser's table is assembled from. Keep edits here to a minimum so the next sync is a diff
// rather than a merge — app-specific behaviour belongs in the components that consume them.

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
// Radix's icon package would be a tenth dependency for three glyphs; lucide-react is already here.
import { Check as CheckIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'border-primary hover:bg-primary/20 focus-visible:ring-ring data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground peer h-4 w-4 shrink-0 rounded-sm border shadow focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('text-background flex items-center justify-center')}>
      <CheckIcon className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
