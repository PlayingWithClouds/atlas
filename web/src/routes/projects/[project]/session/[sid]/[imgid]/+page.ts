import { sessionStatus } from '$lib/api/sessions';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
	const status = await sessionStatus(params.sid);
	return { sid: params.sid, imageId: Number(params.imgid), status };
};
