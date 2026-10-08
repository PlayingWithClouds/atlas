import type { Context } from '@neoworks/extension-system';
import { palette } from '../../kernel/palette.svelte';
import { theme } from '../../kernel/theme.svelte';
import { contribute } from '../shared/contribute';
import ProjectIndexRedirect from '../shared/ProjectIndexRedirect.svelte';
import RootRedirect from '../shared/RootRedirect.svelte';
import ProjectsPage from './ProjectsPage.svelte';

export const projectsPlugin = {
  name: 'core-projects',
  inject: ['routes', 'commands'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.root', path: '/', component: RootRedirect });
    contribute(ctx, ctx.routes, { id: 'core.projects', path: '/projects', component: ProjectsPage });
    contribute(ctx, ctx.routes, { id: 'core.project-index', path: '/projects/:project', component: ProjectIndexRedirect });

    contribute(ctx, ctx.commands, {
      id: 'core.projects.all',
      label: 'All projects',
      group: 'Projects',
      run: () => ctx.router.navigate('/projects'),
    });
    contribute(ctx, ctx.commands, {
      id: 'core.theme.toggle',
      label: 'Toggle light / dark theme',
      group: 'App',
      run: () => theme.toggle(),
    });
    contribute(ctx, ctx.commands, {
      id: 'core.palette.open',
      label: 'Search commands',
      group: 'App',
      run: () => palette.show(),
    });
  },
};
