import type { Context } from '@neoworks/extension-system';
import { createRegistry } from '../kernel/registry.svelte';

const REGISTRY_KEYS = [
  'routes',
  'nav',
  'commands',
  'gridLabelers',
  'itemLabelers',
  'mediaCells',
  'annotationTools',
  'sourcePickers',
  'projectTemplates',
  'settingsPanes',
  'insightsViews',
  'overviewWidgets',
  'paramEditors',
  'nodePresentations',
  'toolbarActions',
  'jobRenderers',
  'liveHandlers',
] as const;

/** Provides every contribution registry as a plain object (rune-backed, so not a Service). */
export const registriesPlugin = {
  name: 'core-registries',
  apply(ctx: Context) {
    for (const key of REGISTRY_KEYS) {
      ctx.provide(key, createRegistry());
    }
  },
};
