import assert from "node:assert/strict";
import test from "node:test";

import { installTrackerBlocker, isTrackerHost } from "../lib/tracker-hosts.js";

// Exercises the userscript path: Tampermonkey has no declarativeNetRequest, so the
// page's own networking APIs are the only place a tracker can be stopped. Each
// case checks both that the telemetry request is suppressed and that ordinary
// traffic still goes through.
function createScope() {
  const sent = [];
  const scope = {
    location: { href: "https://partner.rta-os.com/index" },
    Response,
    fetch(input, init) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      sent.push({ kind: "fetch", url, init });
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
    navigator: {
      sendBeacon(url, data) {
        sent.push({ kind: "beacon", url, data });
        return true;
      },
    },
  };

  class FakeXHR {
    constructor() {
      this.events = [];
      this.openedWith = null;
      this.method = null;
    }
    open(method, url) {
      this.method = method;
      this.openedWith = url;
    }
    send(body) {
      sent.push({ kind: "xhr", url: this.openedWith, body });
    }
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    }
  }
  scope.XMLHttpRequest = FakeXHR;
  return { scope, sent, FakeXHR };
}

test("the analytics collector is blocked on fetch and reports success", async () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);

  const response = await scope.fetch("https://logman.rta-os.com/", {
    method: "POST",
    body: "data=secret",
  });
  assert.equal(sent.length, 0, "nothing may leave the browser");
  assert.equal(response.status, 204, "the SDK sees a successful send");

  // A relative-looking or absolute URL to the same host is caught too.
  await scope.fetch(new URL("https://logman.rta-os.com/collect"));
  assert.equal(sent.length, 0);
});

test("ordinary RTA traffic is untouched", async () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);

  await scope.fetch("https://partner.rta-os.com/api/list");
  await scope.fetch(new URL("https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=" + "a".repeat(32)));
  assert.deepEqual(
    sent.map((entry) => entry.url),
    [
      "https://partner.rta-os.com/api/list",
      `https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=${"a".repeat(32)}`,
    ],
  );
});

test("an unparsable URL is never blocked by accident", async () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);
  await scope.fetch("not a url at all");
  assert.equal(sent.length, 1);
});

test("XMLHttpRequest to the collector is suppressed but still completes", async () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);

  const blocked = new scope.XMLHttpRequest();
  blocked.open("POST", "https://logman.rta-os.com/");
  blocked.send("data=secret");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "the XHR must not reach the network");
  assert.ok(blocked.events.includes("load"), "the SDK must see a completed request");

  const allowed = new scope.XMLHttpRequest();
  allowed.open("GET", "https://partner.rta-os.com/api/list");
  allowed.send();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://partner.rta-os.com/api/list");
});

test("sendBeacon to the collector is dropped", () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);

  assert.equal(scope.navigator.sendBeacon("https://logman.rta-os.com/", "x"), true);
  assert.equal(scope.navigator.sendBeacon("https://partner.rta-os.com/api/list", "x"), true);
  assert.deepEqual(sent.map((entry) => entry.url), [
    "https://partner.rta-os.com/api/list",
  ]);
});

test("installing twice does not wrap the API twice", async () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);
  const wrapped = scope.fetch;
  installTrackerBlocker(scope);
  assert.equal(scope.fetch, wrapped);

  await scope.fetch("https://partner.rta-os.com/api/list");
  assert.equal(sent.length, 1, "the request must be forwarded exactly once");
});

test("blocking is per host, not per substring", async () => {
  const { scope, sent } = createScope();
  installTrackerBlocker(scope);
  for (const url of [
    "https://logman.rta-os.com.evil.test/",
    "https://notlogman.rta-os.com/",
  ]) {
    await scope.fetch(url);
  }
  assert.equal(sent.length, 2);
  assert.equal(isTrackerHost("logman.rta-os.com.evil.test"), false);
});
