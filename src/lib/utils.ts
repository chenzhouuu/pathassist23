// The shadcn class-merge helper. Every vendored OHIF ui-next component imports this, and it is
// the single reason `clsx` and `tailwind-merge` are dependencies.
//
// clsx flattens conditional class expressions; twMerge then resolves Tailwind conflicts by
// last-wins within a group, so a caller's `px-6` overrides a component's built-in `px-4` instead
// of the pair both landing in the class list and letting stylesheet order decide.
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
