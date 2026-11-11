import type { Context } from '@neoworks/extension-system';
import GearSixIcon from 'phosphor-svelte/lib/GearSix';
import { contribute } from '../shared/contribute';
import SettingsPage from './SettingsPage.svelte';

export const settingsPlugin = {
  name: 'core-settings',
  inject: ['routes', 'nav', 'commands', 'router'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.settings', path: '/projects/:project/settings', component: SettingsPage });
    contribute(ctx, ctx.nav, { id: 'core.settings', label: 'Settings', icon: GearSixIcon, path: 'settings', order: 90 });
    contribute(ctx, ctx.commands, {
      id: 'core.settings.open',
      label: 'Settings',
      group: 'App',
      when: () => ctx.router.current?.params.project !== undefined,
      run: () => ctx.router.navigate(`/projects/${ctx.router.current?.params.project}/settings`),
    });
  },
};
