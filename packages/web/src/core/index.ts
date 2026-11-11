import { labelingPlugin } from './labeling';
import { projectsPlugin } from './projects';
import { queuePlugin } from './queue';
import { registriesPlugin } from './registries';
import { servicesPlugin } from './services';
import { settingsPlugin } from './settings';
import { taxonomyPlugin } from './taxonomy';

/** Core plugins in mount order: registries first, then services, then pages. */
export const corePlugins = [registriesPlugin, servicesPlugin, projectsPlugin, queuePlugin, taxonomyPlugin, labelingPlugin, settingsPlugin];
