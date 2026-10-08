import { expect, test } from "bun:test";
import { startHost, urlOf } from "./helpers";

test("keyed persist replaces; unkeyed accumulate; dismiss and clear", async () => {
  const host = await startHost();
  const notifications = host.context.notifications;
  const first = notifications.persist({ key: "k", message: "one" });
  const second = notifications.persist({ key: "k", message: "two", level: "success" });
  expect(second.id).toBe(first.id);
  notifications.persist({ message: "free" });
  notifications.persist({ message: "free" });
  expect(notifications.list()).toHaveLength(3);
  expect(notifications.list().find((entry) => entry.key === "k")).toMatchObject({ message: "two", level: "success" });

  notifications.dismiss(first.id);
  expect(notifications.list()).toHaveLength(2);

  await fetch(urlOf(host, "/api/notifications/clear"), { method: "POST" });
  expect(await (await fetch(urlOf(host, "/api/notifications"))).json()).toEqual([]);
  await host.stop();
});
