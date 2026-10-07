import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	const { projects } = await parent();
	const first = projects?.[0]?.id ?? 'nsfw-tags';
	throw redirect(307, `/projects/${first}/overview`);
};
