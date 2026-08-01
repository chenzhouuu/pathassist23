// Vendored from the OHIF Viewer — platform/ui-next/src/components/Tabs/Tabs.tsx
// at OHIF/Viewers v3.10.0-beta.151 (4e09f85d5), MIT License,
// Copyright (c) 2018 Open Health Imaging Foundation.
//
// Two edits from upstream: the `cn` import path points at this repo's @/lib/utils, and
// `TabsContent` is dropped — `SegmentationTableConfig` uses the trigger row as a segmented
// control and never renders a panel, and an unused export fails `noUnusedLocals`.
//
// The class strings are upstream's. `data-[state=active]:bg-primary/30` is what makes the active
// segment read as pressed rather than as a separate button, which is the whole reason this is a
// Tabs and not three buttons.

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'bg-primary/20 hover:bg-primary/30 primary-foreground inline-flex h-7 items-center justify-center rounded-md py-1',
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'ring-offset-background focus-visible:ring-ring data-[state=active]:bg-primary/30 data-[state=active]:primary text-foreground inline-flex items-center justify-center whitespace-nowrap rounded px-2 py-1 text-base transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export { Tabs, TabsList, TabsTrigger };
