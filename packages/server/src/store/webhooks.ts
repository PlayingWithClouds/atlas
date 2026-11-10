import type { Context } from "@neoworks/extension-system";
import type { LiveEvent, WebhookConfig, WebhookEvent } from "@atlas/contracts";

export interface WebhookTiming {
  /** Delay before the first retry; doubles each time up to `maximumRetryDelayMs`. */
  firstRetryDelayMs: number;
  maximumRetryDelayMs: number;
  /** Give up on an event this long after its first attempt. */
  giveUpAfterMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_WEBHOOK_TIMING: WebhookTiming = {
  firstRetryDelayMs: 1000,
  maximumRetryDelayMs: 60_000,
  giveUpAfterMs: 5 * 60_000,
  requestTimeoutMs: 10_000,
};

const MAXIMUM_QUEUED_EVENTS = 10_000;

function toWebhookEvent(event: LiveEvent): WebhookEvent | undefined {
  if (event.type === "annotation" || event.type === "taxonomy") {
    return event;
  }
  return undefined;
}

function wants(webhook: WebhookConfig, event: WebhookEvent): boolean {
  if (!webhook.events.includes(event.type)) {
    return false;
  }
  if (webhook.project === undefined) {
    return true;
  }
  return webhook.project === event.projectId;
}

/** Events for one webhook, delivered strictly one after the other. */
class DeliveryQueue {
  private readonly events: WebhookEvent[] = [];
  private draining = false;

  constructor(
    readonly url: string,
    private readonly timing: WebhookTiming,
    private readonly stopSignal: AbortSignal,
    private readonly log: Context["logger"],
  ) {}

  enqueue(event: WebhookEvent): void {
    if (this.events.length >= MAXIMUM_QUEUED_EVENTS) {
      this.events.shift();
      this.log.warn(`webhook ${this.url} is too far behind, dropping its oldest event`);
    }
    this.events.push(event);
    if (!this.draining) {
      this.draining = true;
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    while (this.events.length > 0 && !this.stopSignal.aborted) {
      const event = this.events[0];
      await this.deliverWithRetries(event);
      this.events.shift();
    }
    this.draining = false;
  }

  private async deliverWithRetries(event: WebhookEvent): Promise<void> {
    const startedAt = Date.now();
    let delayMs = this.timing.firstRetryDelayMs;
    while (!this.stopSignal.aborted) {
      const failure = await this.attempt(event);
      if (failure === undefined) {
        return;
      }
      if (Date.now() - startedAt + delayMs > this.timing.giveUpAfterMs) {
        this.log.error(`webhook ${this.url} gave up on a ${event.type} event: ${failure}`);
        return;
      }
      await this.pause(delayMs);
      delayMs = Math.min(delayMs * 2, this.timing.maximumRetryDelayMs);
    }
  }

  /** The reason a delivery failed, or undefined when the receiver accepted the event. */
  private async attempt(event: WebhookEvent): Promise<string | undefined> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.any([this.stopSignal, AbortSignal.timeout(this.timing.requestTimeoutMs)]),
      });
      if (response.ok) {
        return undefined;
      }
      return `HTTP ${response.status}`;
    } catch (error) {
      return String(error);
    }
  }

  private pause(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, durationMs);
      this.stopSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Routes each event to the queue of every webhook that wants it. */
class WebhookDispatcher {
  private readonly queues = new Map<string, DeliveryQueue>();

  constructor(
    private readonly ctx: Context,
    private readonly timing: WebhookTiming,
    private readonly stopSignal: AbortSignal,
  ) {}

  dispatch(event: WebhookEvent): void {
    for (const webhook of this.ctx.workspace.config().webhooks) {
      if (wants(webhook, event)) {
        this.queueFor(webhook).enqueue(event);
      }
    }
  }

  private queueFor(webhook: WebhookConfig): DeliveryQueue {
    const key = JSON.stringify(webhook);
    const existing = this.queues.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const queue = new DeliveryQueue(webhook.url, this.timing, this.stopSignal, this.ctx.logger);
    this.queues.set(key, queue);
    return queue;
  }
}

/**
 * Posts annotation and taxonomy changes to the webhooks of `atlas.json`. Delivery happens in
 * the background and never delays or fails the request that caused the change.
 */
export function Webhooks(ctx: Context, timing: Partial<WebhookTiming> = {}): void {
  const stopper = new AbortController();
  const dispatcher = new WebhookDispatcher(ctx, { ...DEFAULT_WEBHOOK_TIMING, ...timing }, stopper.signal);
  ctx.effect(() => () => stopper.abort(), "webhooks:stop");
  ctx.effect(
    () =>
      ctx.store.subscribe((event) => {
        const webhookEvent = toWebhookEvent(event);
        if (webhookEvent !== undefined) {
          dispatcher.dispatch(webhookEvent);
        }
      }),
    "webhooks:subscribe",
  );
}

Webhooks.inject = ["workspace", "store"];

export default Webhooks;
