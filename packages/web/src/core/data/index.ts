import type { Context } from '@neoworks/extension-system';
import DatabaseIcon from 'phosphor-svelte/lib/Database';
import { contribute } from '../shared/contribute';
import DataRoute from './DataRoute.svelte';

export const dataPlugin = {
  name: 'core-data',
  inject: ['routes', 'nav'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.data', path: '/projects/:project/data', component: DataRoute });
    contribute(ctx, ctx.nav, { id: 'core.data', label: 'Data', icon: DatabaseIcon, path: 'data', order: 20 });
  },
};
