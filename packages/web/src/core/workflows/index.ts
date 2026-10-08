import type { Context } from '@neoworks/extension-system';
import FlowArrowIcon from 'phosphor-svelte/lib/FlowArrow';
import { contribute } from '../shared/contribute';
import WorkflowsRoute from './WorkflowsRoute.svelte';

export const workflowsPlugin = {
  name: 'core-workflows',
  inject: ['routes', 'nav'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.workflows', path: '/projects/:project/workflows', component: WorkflowsRoute });
    contribute(ctx, ctx.nav, { id: 'core.workflows', label: 'Workflows', icon: FlowArrowIcon, path: 'workflows', order: 40 });
  },
};
