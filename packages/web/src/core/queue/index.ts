import type { Context } from '@neoworks/extension-system';
import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
import { contribute } from '../shared/contribute';
import QueuePage from './QueuePage.svelte';
import StartLabelingRoute from './StartLabelingRoute.svelte';

export const queuePlugin = {
  name: 'core-queue',
  inject: ['routes', 'nav', 'commands', 'router'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.queue', path: '/projects/:project/queue', component: QueuePage });
    contribute(ctx, ctx.routes, { id: 'core.start-labeling', path: '/projects/:project/label', component: StartLabelingRoute });
    contribute(ctx, ctx.nav, { id: 'core.queue', label: 'Queue', icon: ListChecksIcon, path: 'queue', order: 10 });
    contribute(ctx, ctx.commands, {
      id: 'core.queue.start',
      label: 'Start labeling',
      group: 'Project',
      when: () => ctx.router.current?.params.project !== undefined,
      run: () => ctx.router.navigate(`/projects/${ctx.router.current?.params.project}/label`),
    });
  },
};
