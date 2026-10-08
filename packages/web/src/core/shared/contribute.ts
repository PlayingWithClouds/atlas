import type { Context } from '@neoworks/extension-system';
import type { Registry } from '@atlas/contracts/web';

/** Registers a contribution so it is removed when the calling plugin unloads. */
export function contribute<T extends { id: string }>(ctx: Context, registry: Registry<T>, contribution: T): void {
  ctx.effect(() => registry.register(contribution), `contribution:${contribution.id}`);
}
