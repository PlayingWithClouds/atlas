import type { Context } from '@neoworks/extension-system';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFour';
import { contribute } from '../shared/contribute';
import OverviewRoute from './OverviewRoute.svelte';

export const overviewPlugin = {
  name: 'core-overview',
  inject: ['routes', 'nav'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.overview', path: '/projects/:project/overview', component: OverviewRoute });
    contribute(ctx, ctx.nav, { id: 'core.overview', label: 'Overview', icon: SquaresFourIcon, path: 'overview', order: 10 });
  },
};
