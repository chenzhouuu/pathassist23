// Vendored from the OHIF Viewer — platform/ui-next/src/components/DataRow/DataRow.tsx
// at OHIF/Viewers v3.10.0-beta.151 (4e09f85d5), MIT License,
// Copyright (c) 2018 Open Health Imaging Foundation.
//
// This is the component OHIF's SegmentationTable draws each row with: SegmentationSegments is a
// loop that hands every segment to a DataRow. Unlike the table around it, DataRow carries no
// segmentation domain — it is a numbered row with a title, a details block, an eye and a menu —
// which is why an artifact row can be one without an adapter pretending to be a segmentation.
//
// Edits from upstream:
//   1. Import paths point at this repo's Button, DropdownMenu, Tooltip, `cn`, and the Icons shim.
//   2. `isLocked`, `description` and the five callbacks are optional. Upstream requires all of
//      them because a segment always has all of them; an artifact does not. A `features` row has
//      nothing to draw, so it gets no eye — which is the ticket's requirement, and is implemented
//      by leaving `onToggleVisibility` off rather than by branching on kind inside the row.
//   3. The eye renders only when `onToggleVisibility` was given. One line, guarding (2).
//   4. The callback props are annotated `React.MouseEvent` instead of upstream's implicit any,
//      which this repo's `strict` tsconfig rejects. A type annotation, no behaviour.
// Everything else — layout, class strings, hover behaviour, the 4-line details cut with its
// tooltip, the number box, the opacity drop when hidden — is upstream's.

import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icons } from './Icons';

interface DataRowProps {
  number: number;
  disableEditing: boolean;
  description?: string;
  details?: { primary: string[]; secondary: string[] };
  //
  isSelected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  //
  isVisible: boolean;
  onToggleVisibility?: (e: React.MouseEvent) => void;
  //
  isLocked?: boolean;
  onToggleLocked?: (e: React.MouseEvent) => void;
  //
  title: string;
  onRename?: (e: React.MouseEvent) => void;
  //
  onDelete?: (e: React.MouseEvent) => void;
  //
  colorHex?: string;
  onColor?: (e: React.MouseEvent) => void;
  className?: string;
}

export const DataRow: React.FC<DataRowProps> = ({
  number,
  title,
  colorHex,
  details,
  onSelect,
  isLocked,
  onToggleVisibility,
  onToggleLocked,
  onRename,
  onDelete,
  onColor,
  isSelected = false,
  isVisible = true,
  disableEditing = false,
  className,
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const isTitleLong = title?.length > 25;
  const rowRef = useRef<HTMLDivElement>(null);

  const handleAction = (action: string, e: React.MouseEvent) => {
    switch (action) {
      case 'Rename':
        onRename?.(e);
        break;
      case 'Lock':
        onToggleLocked?.(e);
        break;
      case 'Delete':
        onDelete?.(e);
        break;
      case 'Color':
        onColor?.(e);
        break;
    }
  };

  const decodeHTML = (html: string) => {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
  };

  const renderDetailText = (text: string, indent: number = 0) => {
    const indentation = '  '.repeat(indent);
    if (text === '') {
      return (
        <div
          key={`empty-${indent}`}
          className="h-2"
        ></div>
      );
    }
    const cleanText = decodeHTML(text);
    return (
      <div
        key={cleanText}
        className="whitespace-pre-wrap"
      >
        {indentation}
        <span className="font-medium">{cleanText}</span>
      </div>
    );
  };

  const renderDetails = (details: string[]) => {
    const visibleLines = details.slice(0, 4);
    const hiddenLines = details.slice(4);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">
            <div className="flex flex-col space-y-1">
              {visibleLines.map((line) => renderDetailText(line, line.startsWith('  ') ? 1 : 0))}
            </div>
            {hiddenLines.length > 0 && (
              <div className="text-muted-foreground mt-1 flex items-center text-sm">
                <span>...</span>
                <Icons.Info className="mr-1 h-5 w-5" />
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          className="max-w-md"
        >
          <div className="text-secondary-foreground flex flex-col space-y-1 text-sm leading-normal">
            {details.map((line) => renderDetailText(line, line.startsWith('  ') ? 1 : 0))}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div
      ref={rowRef}
      className={cn('flex flex-col', !isVisible && 'opacity-60', className)}
    >
      <div
        className={`flex items-center ${
          isSelected ? 'bg-popover' : 'bg-muted'
        } group relative cursor-pointer`}
        onClick={onSelect}
        data-cy="data-row"
      >
        {/* Hover Overlay */}
        <div className="bg-primary/20 pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100"></div>

        {/* Number Box */}
        <div
          className={`flex h-7 max-h-7 w-7 flex-shrink-0 items-center justify-center rounded-l border-r border-black text-base ${
            isSelected ? 'bg-highlight text-black' : 'bg-muted text-muted-foreground'
          } overflow-hidden`}
        >
          {number}
        </div>

        {/* Color Circle (Optional) */}
        {colorHex && (
          <div className="flex h-7 w-5 items-center justify-center">
            <span
              className="ml-2 h-2 w-2 rounded-full"
              style={{ backgroundColor: colorHex }}
            ></span>
          </div>
        )}

        {/* Label with Conditional Tooltip */}
        <div className="ml-2 flex-1 overflow-hidden">
          {isTitleLong ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`cursor-default text-base ${
                    isSelected ? 'text-highlight' : 'text-muted-foreground'
                  } [overflow:hidden] [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]`}
                >
                  {title}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="center"
              >
                {title}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span
              className={`text-base ${
                isSelected ? 'text-highlight' : 'text-muted-foreground'
              } [overflow:hidden] [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]`}
            >
              {title}
            </span>
          )}
        </div>

        {/* Actions and Visibility Toggle */}
        <div className="relative ml-2 flex items-center space-x-1">
          {/* Visibility Toggle Icon */}
          {onToggleVisibility && (
            <Button
              size="icon"
              variant="ghost"
              className={`h-6 w-6 transition-opacity ${
                isSelected || !isVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              aria-label={isVisible ? 'Hide' : 'Show'}
              onClick={e => {
                e.stopPropagation();
                onToggleVisibility(e);
              }}
            >
              {isVisible ? <Icons.Hide className="h-6 w-6" /> : <Icons.Show className="h-6 w-6" />}
            </Button>
          )}

          {/* Lock Icon (if needed) */}
          {isLocked && !disableEditing && <Icons.Lock className="text-muted-foreground h-6 w-6" />}

          {/* Actions Dropdown Menu */}
          {disableEditing && <div className="h-6 w-6"></div>}
          {!disableEditing && (
            <DropdownMenu onOpenChange={open => setIsDropdownOpen(open)}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className={`h-6 w-6 transition-opacity ${
                    isSelected || isDropdownOpen
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100'
                  }`}
                  aria-label="Actions"
                  onClick={e => e.stopPropagation()} // Prevent row selection on button click
                >
                  <Icons.More className="h-6 w-6" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                // this was causing issue for auto focus on input dialog
                onCloseAutoFocus={e => e.preventDefault()}
              >
                <>
                  <DropdownMenuItem onClick={e => handleAction('Rename', e)}>
                    <Icons.Rename className="text-foreground" />
                    <span className="pl-2">Rename</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={e => handleAction('Delete', e)}>
                    <Icons.Delete className="text-foreground" />
                    <span className="pl-2">Delete</span>
                  </DropdownMenuItem>
                  {onColor && (
                    <DropdownMenuItem onClick={e => handleAction('Color', e)}>
                      <Icons.ColorChange className="text-foreground" />
                      <span className="pl-2">Change Color</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={e => handleAction('Lock', e)}>
                    <Icons.Lock className="text-foreground" />
                    <span className="pl-2">{isLocked ? 'Unlock' : 'Lock'}</span>
                  </DropdownMenuItem>
                </>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Details Section */}
      {details && (details.primary?.length > 0 || details.secondary?.length > 0) && (
        <div className="ml-7 px-2 py-2">
          <div className="text-secondary-foreground flex items-center gap-1 text-base leading-normal">
            {details.primary?.length > 0 && renderDetails(details.primary)}
            {details.secondary?.length > 0 && (
              <div className="text-muted-foreground ml-auto text-sm">
                {renderDetails(details.secondary)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DataRow;
