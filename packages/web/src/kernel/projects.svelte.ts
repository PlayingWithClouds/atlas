import type { ProjectSummary } from '@atlas/contracts';
import type { ApiClient } from '@atlas/contracts/web';
import type { LiveSignal } from './live.svelte';

const REFRESH_DELAY_MS = 250;

/** Reactive list of project summaries (counts included), kept fresh by live events. */
export class ProjectList {
  summaries = $state.raw<ProjectSummary[]>([]);
  /** True after the first answer, so pages can tell "loading" from "empty". */
  loaded = $state(false);
  error = $state('');
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly api: ApiClient) {}

  async refresh(): Promise<void> {
    try {
      this.summaries = await this.api.get<ProjectSummary[]>('/projects');
      this.error = '';
    } catch (failure) {
      this.error = failure instanceof Error ? failure.message : String(failure);
    }
    this.loaded = true;
  }

  find(projectId: string): ProjectSummary | undefined {
    return this.summaries.find((summary) => summary.id === projectId);
  }

  /** Counts change with every annotation, so bursts of events collapse into one refetch. */
  onLive(signal: LiveSignal): void {
    const relevant = signal.type === 'projects' || signal.type === 'annotation' || signal.type === 'items' || signal.type === 'connected';
    if (!relevant) {
      return;
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
  }
}
