import { get } from './client';

// Per-class thumbnail URLs, drawn from labeled dataset images. Scoped to a project,
// so a clip project illustrates its classes with its own clips rather than whatever
// another project happened to label first.
export function getClassThumbnails(project?: string): Promise<{ thumbnails: Record<string, string> }> {
	if (!project) return get('/api/classes/thumbnails');
	return get(`/api/classes/thumbnails?project=${encodeURIComponent(project)}`);
}
