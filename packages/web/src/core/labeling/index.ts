import type { Context } from '@neoworks/extension-system';
import { contribute } from '../shared/contribute';
import LabelPage from './LabelPage.svelte';

export const labelingPlugin = {
  name: 'core-labeling',
  inject: ['routes'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.label', path: '/projects/:project/label/:item', component: LabelPage, focus: true });
  },
};
