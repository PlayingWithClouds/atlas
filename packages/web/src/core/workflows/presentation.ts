import type { Context } from '@neoworks/extension-system';
import type { NodePresentationContribution } from '@atlas/contracts/web';

export function presentationFor(ctx: Context, nodeType: string): NodePresentationContribution | undefined {
  return ctx.nodePresentations.list().find((presentation) => presentation.nodeType === nodeType);
}

/** Inline style tinting a node badge; without a registered color the theme's action color applies. */
export function badgeStyle(presentation: NodePresentationContribution | undefined): string {
  if (!presentation || !presentation.color) {
    return '';
  }
  return `background: color-mix(in srgb, ${presentation.color} 15%, transparent); color: ${presentation.color}`;
}
