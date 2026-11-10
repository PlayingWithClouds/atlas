import type { Context } from '@neoworks/extension-system';
import TagsIcon from 'phosphor-svelte/lib/Tag';
import { contribute } from '../shared/contribute';
import TaxonomyPage from './TaxonomyPage.svelte';

export const taxonomyPlugin = {
  name: 'core-taxonomy',
  inject: ['routes', 'nav', 'commands', 'router'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.taxonomy', path: '/projects/:project/taxonomy', component: TaxonomyPage });
    contribute(ctx, ctx.nav, { id: 'core.taxonomy', label: 'Taxonomy', icon: TagsIcon, path: 'taxonomy', order: 20 });
    contribute(ctx, ctx.commands, {
      id: 'core.taxonomy.open',
      label: 'Edit taxonomy',
      group: 'Project',
      when: () => ctx.router.current?.params.project !== undefined,
      run: () => ctx.router.navigate(`/projects/${ctx.router.current?.params.project}/taxonomy`),
    });
  },
};
