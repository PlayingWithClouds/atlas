// Built-in annotation primitives — mirrors backend/core/primitives.py. This is
// the data vocabulary exchanged with plugins and held per image. Only `tag`
// (whole-image multi-label) is wired end-to-end today; the region types are
// reserved for the visual-annotation phase.

export type AnnotationType = 'tag' | 'rect' | 'polygon' | 'keypoint' | 'mask';

export type Annotation = {
	type: AnnotationType;
	value: Record<string, unknown>;
};

export type Prediction = Annotation & {
	score?: number;
	source?: string;
	evidence?: string;
};

export type ImageRef = {
	id: number;
	ref: string;
	url?: string;
	width?: number;
	height?: number;
	meta?: Record<string, unknown>;
};

export type AnnotationSet = {
	imageId: number;
	annotations: Annotation[];
};

// A whole-image multi-label annotation (one region carrying all labels).
export function tag(labels: string[]): Annotation {
	return { type: 'tag', value: { labels } };
}

export function tagsToAnnotations(labels: string[]): Annotation[] {
	return labels.length ? [tag(labels)] : [];
}

export function labelsOf(annotations: Annotation[]): string[] {
	return annotations.flatMap((a) =>
		a.type === 'tag' ? ((a.value.labels as string[]) ?? []) : []
	);
}
