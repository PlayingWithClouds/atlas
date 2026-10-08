import { dataPlugin } from './data';
import { insightsPlugin } from './insights';
import { overviewPlugin } from './overview';
import { paramEditorsPlugin } from './params';
import { projectsPlugin } from './projects';
import { registriesPlugin } from './registries';
import { servicesPlugin } from './services';
import { sessionPlugin } from './session';
import { settingsPlugin } from './settings';
import { workflowsPlugin } from './workflows';

/** Core plugins in mount order: registries first, then services, then pages. */
export const corePlugins = [
  registriesPlugin,
  servicesPlugin,
  paramEditorsPlugin,
  projectsPlugin,
  overviewPlugin,
  dataPlugin,
  sessionPlugin,
  workflowsPlugin,
  insightsPlugin,
  settingsPlugin,
];
