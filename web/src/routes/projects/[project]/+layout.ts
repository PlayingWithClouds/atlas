import { setActiveProject } from '$lib/stores/projects';
import { getClassThumbnails } from '$lib/api/classes';
import { installThumbnails } from '$lib/labels';
import type { LayoutLoad } from './$types';

// Install this project's label schema before its pages render, along with the class
// thumbnails drawn from this project's own labeled entities — the root layout can
// only load them unscoped, which illustrates a class with another project's media.
export const load: LayoutLoad = async ({ params }) => {
	const [project, thumbs] = await Promise.all([
		setActiveProject(params.project),
		getClassThumbnails(params.project).catch(() => ({ thumbnails: {} }))
	]);
	installThumbnails(thumbs.thumbnails);
	return { project };
};
