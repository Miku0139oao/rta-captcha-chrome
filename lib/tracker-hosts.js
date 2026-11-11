// Hosts RTA's own web UI calls for analytics only. They carry no functional
// traffic: blocking them stops behavioural telemetry (user id, screen size, user
// agent, page URL, session counters) from leaving the browser.
//
// This is deliberately a narrow allow-by-default blocklist. Every entry must be
// a host whose only purpose is measurement, and the list is shared by the
// extension's declarativeNetRequest rules and the Tampermonkey build so the two
// cannot drift apart. A test cross-checks the rule file against this list.
export const TRACKER_HOSTS = Object.freeze([
  // Dmall analytics collector: POST / with a base64 JSON event body.
  "logman.rta-os.com",
]);

export function isTrackerHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") {
    return false;
  }
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return TRACKER_HOSTS.includes(normalized);
}

// Tampermonkey has no declarativeNetRequest, so the userscript removes the
// trackers from the page's own networking APIs before any site script runs.
// Success is reported as an opaque empty response rather than an exception: the
// analytics SDK then treats the event as sent and does not retry, while the page
// keeps working. Nothing is forwarded anywhere.
export function installTrackerBlocker(target) {
  const scope = target ?? globalThis;
  if (typeof scope.fetch !== "function") {
    return;
  }
  if (scope.__rtaCaptchaTrackerBlockerInstalled === true) {
    return;
  }
  scope.__rtaCaptchaTrackerBlockerInstalled = true;

  const originalFetch = scope.fetch;
  const isBlocked = (input) => {
    try {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input?.url;
      if (typeof raw !== "string") {
        return false;
      }
      // Relative URLs cannot reach these hosts, so they never need parsing.
      return isTrackerHost(
        new URL(raw, scope.location?.href ?? undefined).hostname,
      );
    } catch {
      return false;
    }
  };

  scope.fetch = function blockedFetch(input, init) {
    if (isBlocked(input)) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return originalFetch.call(scope, input, init);
  };

  const XHR = scope.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    XHR.prototype.open = function blockedOpen(method, url, ...rest) {
      this.__rtaCaptchaBlocked = isBlocked(url);
      if (this.__rtaCaptchaBlocked) {
        // Still open a real request handle so the object stays usable; send()
        // is where the request is suppressed.
        return originalOpen.call(this, method, "about:blank", ...rest);
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function blockedSend(...args) {
      if (this.__rtaCaptchaBlocked) {
        queueMicrotask(() => {
          this.dispatchEvent(new Event("load"));
          this.dispatchEvent(new Event("loadend"));
        });
        return;
      }
      return originalSend.apply(this, args);
    };
  }

  if (typeof scope.navigator?.sendBeacon === "function") {
    const originalBeacon = scope.navigator.sendBeacon.bind(scope.navigator);
    scope.navigator.sendBeacon = function blockedBeacon(url, data) {
      if (isBlocked(url)) {
        return true;
      }
      return originalBeacon(url, data);
    };
  }
}
