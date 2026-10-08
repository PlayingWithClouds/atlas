import type { Context } from '@neoworks/extension-system';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
import { contribute } from '../shared/contribute';
import SessionIndexRoute from './SessionIndexRoute.svelte';
import SessionItemRoute from './SessionItemRoute.svelte';
import SessionDetailRoute from './SessionDetailRoute.svelte';

export const sessionPlugin = {
  name: 'core-session',
  inject: ['routes', 'nav'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.session.index', path: '/projects/:project/session', component: SessionIndexRoute });
    contribute(ctx, ctx.routes, { id: 'core.session', path: '/projects/:project/session/:session', component: SessionDetailRoute });
    contribute(ctx, ctx.routes, { id: 'core.session.item', path: '/projects/:project/session/:session/:item', component: SessionItemRoute });
    contribute(ctx, ctx.nav, { id: 'core.session', label: 'Annotate', icon: PencilSimpleIcon, path: 'session', order: 30 });
  },
};
