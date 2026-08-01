// Vendored from the OHIF Viewer — platform/ui-next/src/components/PanelSection/PanelSection.tsx
// at OHIF/Viewers v3.10.0-beta.151 (4e09f85d5), MIT License,
// Copyright (c) 2018 Open Health Imaging Foundation.
//
// Two edits from upstream: the import paths point at this repo's copies of Accordion and `cn`,
// and upstream's `Icons` import is dropped — this version of the file never renders it, and an
// unused import fails `noUnusedLocals`.
//
// The class strings are upstream's, unedited. `bg-secondary-dark` and `text-aqua-pale` are OHIF
// theme names, declared in tailwind.config.js against triplets this repo's palette already holds.
//
// This directory is where the rest of OHIF's segmentation table lands in Inc 5 ticket 02. Keep
// edits here to the minimum a copy needs to compile, so the next sync is a diff and not a merge —
// anything app-specific belongs in the panel that consumes these components.

import React from 'react';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';

interface PanelSectionProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

interface PanelSectionHeaderProps {
  children: React.ReactNode;
  className?: string;
  showChevron?: boolean;
}

interface PanelSectionContentProps {
  children: React.ReactNode;
  className?: string;
}

export const PanelSection: React.FC<PanelSectionProps> & {
  Header: React.FC<PanelSectionHeaderProps>;
  Content: React.FC<PanelSectionContentProps>;
} = ({ children, defaultOpen = true, className }) => {
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={defaultOpen ? 'item' : undefined}
      className={cn('flex-shrink-0 overflow-hidden', className)}
    >
      <AccordionItem
        value="item"
        className="border-none"
      >
        {children}
      </AccordionItem>
    </Accordion>
  );
};

PanelSection.Header = ({ children, className }) => (
  <AccordionTrigger
    className={cn(
      'bg-secondary-dark hover:bg-accent text-aqua-pale',
      'my-0.5 flex h-7 w-full items-center justify-between rounded py-2 pr-1 pl-2.5 text-[13px]',
      className
    )}
  >
    {children}
  </AccordionTrigger>
);

PanelSection.Header.displayName = 'PanelSection.Header';

PanelSection.Content = ({ children, className }) => (
  <AccordionContent className={cn('overflow-hidden p-0', className)}>
    <div className="rounded-b">{children}</div>
  </AccordionContent>
);

PanelSection.Content.displayName = 'PanelSection.Content';
