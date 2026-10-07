// This is a local single-user tool with a live backend — render entirely on the
// client so every fetch hits the proxied /api same-origin, no SSR round-trips.
import { loadAppConfig } from '$lib/stores/config';
import { seedClasses } from '$lib/stores/classes';
import { loadProjects } from '$lib/stores/projects';
import { getClassThumbnails } from '$lib/api/classes';
import { installThumbnails } from '$lib/labels';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const prerender = false;

// Fetch the startup config + project list before any page renders. The per-project
// layout installs that project's label schema; this seeds model prefs + the switcher.
// Class thumbnails come from labeled dataset images.
export const load: LayoutLoad = async () => {
	const [config, projects, thumbs] = await Promise.all([
		loadAppConfig(),
		loadProjects(),
		getClassThumbnails().catch(() => ({ thumbnails: {} }))
	]);
	seedClasses(config.default_classes ?? []);
	installThumbnails(thumbs.thumbnails);
	return { config, projects };
};
