import { get } from './client';

export type ClassInsight = {
	name: string;
	support: number;
	negatives: number;
	evaluated: boolean;
	average_precision?: number;
	f1?: number;
	precision?: number;
	recall?: number;
	threshold?: number;
	baserate?: number;
	folds?: number;
};

export type Insights = { pool: number; backbone: string | null; classes: ClassInsight[] };

// Cross-validated per class over one project's pool.
export function getInsights(project: string): Promise<Insights> {
	return get(`/api/insights?project=${encodeURIComponent(project)}`);
}
