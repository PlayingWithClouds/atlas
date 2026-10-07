import { get } from './client';

export type RandomImage = { galleryId: string; gallery: string; url: string };

export function randomImages(count = 60): Promise<RandomImage[]> {
	return get(`/api/random/images?count=${count}`);
}
