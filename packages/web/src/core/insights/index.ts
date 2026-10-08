import type { Context } from '@neoworks/extension-system';
import ChartLineIcon from 'phosphor-svelte/lib/ChartLine';
import { contribute } from '../shared/contribute';
import InsightsRoute from './InsightsRoute.svelte';
import MetricsView from './MetricsView.svelte';
import StatsView from './StatsView.svelte';

export const insightsPlugin = {
  name: 'core-insights',
  inject: ['routes', 'nav', 'insightsViews'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.insights', path: '/projects/:project/insights', component: InsightsRoute });
    contribute(ctx, ctx.nav, { id: 'core.insights', label: 'Insights', icon: ChartLineIcon, path: 'insights', order: 50 });
    contribute(ctx, ctx.insightsViews, { id: 'core.insights.stats', label: 'Stats', order: 10, component: StatsView });
    contribute(ctx, ctx.insightsViews, { id: 'core.insights.metrics', label: 'Class metrics', order: 20, component: MetricsView });
  },
};
