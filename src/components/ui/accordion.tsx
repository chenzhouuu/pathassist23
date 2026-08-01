// Vendored from the OHIF Viewer — platform/ui-next/src/components/Accordion/Accordion.tsx
// at OHIF/Viewers v3.10.0-beta.151 (4e09f85d5), MIT License,
// Copyright (c) 2018 Open Health Imaging Foundation.
//
// One edit from upstream: the `cn` import path now points at this repo's @/lib/utils. The class
// strings, the chevron and its rotation states are upstream's, because PanelSection and — from
// Inc 5 ticket 02 — the segmentation table are written against exactly this behaviour.
//
// The `animate-accordion-up` / `-down` utilities it references come from the keyframes in
// tailwind.config.js; without them a collapse is instant rather than animated.

'use client';

import * as React from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDownIcon } from '@radix-ui/react-icons';

import { cn } from '@/lib/utils';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn(className)}
    {...props}
  />
));
AccordionItem.displayName = 'AccordionItem';

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex flex-1 items-center justify-between py-2 px-2 text-base font-medium transition-transform duration-200',
        className,
        '[&[data-state=open]>svg]:rotate-270',
        '[&[data-state=closed]>svg]:rotate-90'
      )}
      {...props}
    >
      {props.asChild ? (
        children
      ) : (
        <>
          {children}
          <ChevronDownIcon className="text-primary h-4 w-4 shrink-0 transition-transform duration-200" />
        </>
      )}
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-base"
    {...props}
  >
    <div className={cn(className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
