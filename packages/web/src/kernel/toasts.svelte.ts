import type { Toasts } from '@atlas/contracts/web';

export interface ToastView {
  id: string;
  message: string;
  level: 'info' | 'success' | 'error';
}

const TOAST_LIFETIME_MS = 5000;

export class ToastQueue implements Toasts {
  items = $state.raw<ToastView[]>([]);
  private sequence = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  push(message: string, level: ToastView['level'] = 'info', id?: string): void {
    this.sequence += 1;
    const toastId = id === undefined ? `local-${this.sequence}` : id;
    this.items = [...this.items, { id: toastId, message, level }];
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.dismiss(toastId);
    }, TOAST_LIFETIME_MS);
    this.timers.add(timer);
  }

  dismiss(id: string): void {
    this.items = this.items.filter((toast) => toast.id !== id);
  }

  dispose(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.items = [];
  }
}
