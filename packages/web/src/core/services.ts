import type { Context } from '@neoworks/extension-system';
import { createApiClient } from '../kernel/api';
import { connectLive, LiveState, webSocketUrl } from '../kernel/live.svelte';
import { Router } from '../kernel/router.svelte';
import { ToastQueue } from '../kernel/toasts.svelte';

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function internalAnchorOf(event: MouseEvent): HTMLAnchorElement | undefined {
  const target = event.target as Element | null;
  const anchor = target ? target.closest('a') : null;
  if (!anchor || !anchor.href) {
    return undefined;
  }
  if (anchor.target && anchor.target !== '_self') {
    return undefined;
  }
  if (anchor.origin !== location.origin || anchor.hasAttribute('download')) {
    return undefined;
  }
  if (anchor.pathname.startsWith('/api/')) {
    return undefined;
  }
  return anchor;
}

function installRouting(ctx: Context, router: Router): void {
  ctx.effect(() => {
    const onPopState = () => router.syncFromLocation();
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !isPlainLeftClick(event)) {
        return;
      }
      const anchor = internalAnchorOf(event);
      if (!anchor) {
        return;
      }
      event.preventDefault();
      router.navigate(anchor.pathname + anchor.search);
    };
    window.addEventListener('popstate', onPopState);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('click', onClick);
    };
  }, 'router:history');
}

/** api, toasts, live state + socket, and the router. */
export const servicesPlugin = {
  name: 'core-services',
  inject: ['routes', 'liveHandlers'],
  apply(ctx: Context) {
    const toastQueue = new ToastQueue();
    const live = new LiveState();
    const router = new Router(ctx.routes, location.pathname);

    ctx.provide('api', createApiClient());
    ctx.provide('toastQueue', toastQueue);
    ctx.provide('toasts', toastQueue);
    ctx.provide('live', live);
    ctx.provide('router', router);

    ctx.effect(() => () => toastQueue.dispose(), 'toasts:timers');
    ctx.effect(
      () => connectLive({ state: live, toasts: toastQueue, handlers: ctx.liveHandlers, url: webSocketUrl(location) }),
      'live:socket',
    );
    installRouting(ctx, router);
  },
};
