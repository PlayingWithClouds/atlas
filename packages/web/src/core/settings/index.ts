import type { Context } from '@neoworks/extension-system';
import GearSixIcon from 'phosphor-svelte/lib/GearSix';
import { contribute } from '../shared/contribute';
import GeneralPane from './GeneralPane.svelte';
import SettingsRoute from './SettingsRoute.svelte';

export const settingsPlugin = {
  name: 'core-settings',
  inject: ['routes', 'nav', 'settingsPanes'],
  apply(ctx: Context) {
    contribute(ctx, ctx.routes, { id: 'core.settings', path: '/projects/:project/settings', component: SettingsRoute });
    contribute(ctx, ctx.nav, { id: 'core.settings', label: 'Settings', icon: GearSixIcon, path: 'settings', order: 60 });
    contribute(ctx, ctx.settingsPanes, { id: 'core.settings.general', label: 'General', order: 10, component: GeneralPane });
  },
};
