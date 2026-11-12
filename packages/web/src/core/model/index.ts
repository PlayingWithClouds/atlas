import type { Context } from '@neoworks/extension-system';
import BrainIcon from 'phosphor-svelte/lib/Brain';
import { contribute } from '../shared/contribute';
import ModelPage from './ModelPage.svelte';

/** Where the model's suggestions are sure and unsure, per label, linking into the filtered queue. */
export const modelPlugin = {
  name: 'core-model',
  inject: ['routes', 'nav'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.model', path: '/projects/:project/model', component: ModelPage });
    contribute(ctx, ctx.nav, { id: 'core.model', label: 'Model', icon: BrainIcon, path: 'model', order: 15 });
  },
};
