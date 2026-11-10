import '@atlas/contracts/web';
import type { LiveState } from './live.svelte';
import type { ProjectList } from './projects.svelte';
import type { Router } from './router.svelte';
import type { ToastQueue } from './toasts.svelte';

/** Web-internal services on top of the contract registries. */
declare module '@neoworks/extension-system' {
  interface Context {
    live: LiveState;
    projects: ProjectList;
    router: Router;
    toastQueue: ToastQueue;
  }
}
