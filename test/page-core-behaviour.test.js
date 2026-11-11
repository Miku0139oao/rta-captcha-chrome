import assert from "node:assert/strict";
import test from "node:test";

import { createCaptchaPage } from "../lib/page-core.js";

// A tiny stand-in for the handful of DOM APIs page-core touches. It is not a
// browser, but it is enough to drive the state machine: the two behaviours that
// matter here (refresh an expired challenge, always overwrite the field) are
// observable through which methods the fakes see called.
function createFakeDom() {
  const listeners = new Map();
  let clock = 0;

  class FakeElement {
    constructor() {
      this.connected = true;
      this.dataset = {};
      this.style = {};
      this.title = '';
      this.dispatched = [];
    }
    get isConnected() {
      return this.connected;
    }
    matches(selector) {
      return selector === "img#verifyCodeMsg" && this.id === "verifyCodeMsg";
    }
    closest(selector) {
      return selector === "img" && this.tagName === "IMG" ? this : null;
    }
    contains() {
      return false;
    }
    tagName = "DIV";
    addEventListener(type, handler) {
      const key = 'el:' + type;
      const list = listeners.get(key) ?? [];
      list.push(handler);
      listeners.set(key, list);
    }
    removeEventListener(type, handler) {
      const key = 'el:' + type;
      listeners.set(
        key,
        (listeners.get(key) ?? []).filter((entry) => entry !== handler),
      );
    }
    dispatchEvent(event) {
      this.dispatched.push(event.type);
      return true;
    }
    getBoundingClientRect() {
      return { width: 100, height: 20 };
    }
    focus() {}
    select() {}
  }

  class FakeImage extends FakeElement {
    constructor() {
      super();
      this.complete = true;
      this.naturalWidth = 120;
      this.naturalHeight = 30;
      this.id = "verifyCodeMsg";
      this.tagName = "IMG";
      this.clicks = 0;
    }
    click() {
      this.clicks += 1;
      // The site swaps in a new challenge asynchronously.
      queueMicrotask(() => {
        this.currentSrc = `https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=${"a".repeat(31)}${this.clicks % 10}`;
        this.src = this.currentSrc;
        emit("load", this);
      });
    }
  }

  const image = new FakeImage();

  class FakeInput extends FakeElement {
    constructor() {
      super();
      this.type = "text";
      this.disabled = false;
      this.autocomplete = "";
      this.name = "input-verify_code";
      this.id = "verifyCode";
      this._value = "stale-typed-value";
      this.initialValue = this._value;
    }
    get value() {
      return this._value;
    }
    set value(next) {
      this._value = next;
    }
  }

  const input = new FakeInput();

  Object.defineProperty(globalThis, "HTMLImageElement", {
    configurable: true,
    value: FakeImage,
  });
  Object.defineProperty(globalThis, "HTMLInputElement", {
    configurable: true,
    value: FakeInput,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: FakeElement,
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  });
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => clock },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://mansso.rta-os.com/login", hash: "" },
  });
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, "requestIdleCallback", {
    configurable: true,
    value: (run) => {
      queueMicrotask(run);
      return 1;
    },
  });
  Object.defineProperty(globalThis, "cancelIdleCallback", {
    configurable: true,
    value: () => undefined,
  });

  image.currentSrc = "https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=" + "b".repeat(32);
  image.src = image.currentSrc;

  const document = {
    documentElement: new FakeElement(),
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    querySelector(selector) {
      if (selector.includes("img")) {
        return image;
      }
      if (selector.includes("input")) {
        return input;
      }
      return null;
    },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });

  const window = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    addEventListener(type, handler) {
      const list = listeners.get(`win:${type}`) ?? [];
      list.push(handler);
      listeners.set(`win:${type}`, list);
    },
    setTimeout: (handler, delay) => setTimeout(handler, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });

  function emit(type, target) {
    for (const handler of listeners.get(type) ?? []) {
      handler({ type, target });
    }
  }

  function emitDoubleClick(event) {
    for (const handler of listeners.get("dblclick") ?? []) {
      handler(event);
    }
  }

  function emitWindow(type, target) {
    for (const handler of listeners.get('win:' + type) ?? []) {
      handler({ type, target });
    }
  }

  return {
    image,
    input,
    emit,
    emitDoubleClick,
    emitWindow,
    advance(ms) {
      clock += ms;
    },
    currentTime: () => clock,
  };
}

function doubleClickEvent(target) {
  return {
    target,
    defaultPrevented: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

test("an answer is prefetched once and reused without re-OCR", async () => {
  const dom = createFakeDom();
  let calls = 0;
  const page = createCaptchaPage({
    recognize: async () => {
      calls += 1;
      return "0be7f";
    },
  });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "prefetch should have run once");

  await page.fillNow();
  assert.equal(dom.input.value, "0be7f");
  assert.equal(calls, 1, "the cached answer should be reused");
});

test("filling overwrites a value the user already typed", async () => {
  const dom = createFakeDom();
  const page = createCaptchaPage({ recognize: async () => "e2c63" });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dom.input.value, "stale-typed-value");
  await page.fillNow();
  // A stale captcha typed earlier is always wrong; the fill must replace it.
  assert.equal(dom.input.value, "e2c63");
  assert.ok(dom.input.dispatched.includes("input"));
  assert.ok(dom.input.dispatched.includes("change"));
});

test("an expired challenge is refreshed before it is read", async () => {
  const dom = createFakeDom();
  const seen = [];
  const page = createCaptchaPage({
    recognize: async (_image, token) => {
      seen.push(token);
      return "aaaaa";
    },
    ttlMs: 1_000,
  });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const clicksBefore = dom.image.clicks;

  // Past the challenge lifetime: nothing about the on-screen image can be
  // trusted, so the fill must ask the site for a new one first.
  dom.advance(1_500);
  await page.fillNow();
  assert.equal(dom.image.clicks, clicksBefore + 1, "the captcha should be refreshed");
  assert.equal(dom.input.value, "aaaaa");
});

test("a fresh challenge is not refreshed", async () => {
  const dom = createFakeDom();
  const page = createCaptchaPage({ recognize: async () => "beef0" });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await page.fillNow();
  assert.equal(dom.image.clicks, 0, "a fresh challenge must not be replaced");
  assert.equal(dom.input.value, "beef0");
});

test("an answer that arrives after the challenge changed is discarded", async () => {
  const dom = createFakeDom();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const page = createCaptchaPage({
    recognize: async () => {
      await gate;
      return "abcde";
    },
  });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const fill = page.fillNow();
  // The user (or the site) swaps the challenge while OCR is still running.
  dom.image.currentSrc = `https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=${"c".repeat(32)}`;
  dom.image.src = dom.image.currentSrc;
  dom.emit("load", dom.image);
  release();
  await fill;
  assert.notEqual(dom.input.value, "abcde", "a stale answer must not be filled");
});

test("leaving the login page releases platform resources", async () => {
  const dom = createFakeDom();
  let released = 0;
  const page = createCaptchaPage({
    recognize: async () => "12345",
    release: () => {
      released += 1;
    },
  });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));

  dom.image.connected = false;
  // page-core registers pagehide on window, not document.
  dom.emitWindow("pagehide", dom.image);
  void page;
  assert.equal(released, 1);
});

test("a failed captcha load drops the cached answer", async () => {
  const dom = createFakeDom();
  let calls = 0;
  const page = createCaptchaPage({
    recognize: async () => {
      calls += 1;
      return "0be7f";
    },
  });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "the first challenge should have been prefetched");

  // The site starts loading a replacement challenge and it fails. No load event
  // will follow, so the answer for the previous challenge must not survive.
  dom.image.currentSrc = `https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=${"d".repeat(32)}`;
  dom.image.src = dom.image.currentSrc;
  dom.emit("error", dom.image);

  await page.fillNow();
  assert.equal(calls, 2, "OCR must run again instead of reusing the dropped answer");
});

test("the OCR answer replaces whatever the field holds, including nothing", async () => {
  // The captcha server keeps its own answer for the challenge. Whatever the
  // user has in the field -- a wrong code, a partial code, or nothing at all --
  // is discarded, because only the answer that matches the challenge can pass.
  const cases = [
    ["", "an empty field"],
    ["   ", "whitespace only"],
    ["fffff", "a wrong but well-formed code"],
    ["abc", "a partial code"],
    ["ZZZZZ", "garbage"],
    ["stale-typed-value", "leftover text"],
  ];

  for (const [initial, description] of cases) {
    const dom = createFakeDom();
    dom.input.value = initial;
    const page = createCaptchaPage({ recognize: async () => "0be7f" });
    page.install();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await page.fillNow();
    assert.equal(dom.input.value, "0be7f", `fill should win over ${description}`);
    assert.ok(dom.input.dispatched.includes("input"), description);
    assert.ok(dom.input.dispatched.includes("change"), description);
  }
});

test("filling works when the field was never focusable or touched", async () => {
  const dom = createFakeDom();
  dom.input.value = "";
  const page = createCaptchaPage({ recognize: async () => "e2c63" });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // No dblclick at all: the toolbar button path calls fillNow directly.
  await page.fillNow();
  assert.equal(dom.input.value, "e2c63");
});

test("double-clicking the captcha image fills too", async () => {
  // The old build accepted three entry points: the field, the image, and the
  // toolbar button. Losing the image one was a regression.
  const dom = createFakeDom();
  const page = createCaptchaPage({ recognize: async () => "0be7f" });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const clickOnImage = doubleClickEvent(dom.image);
  dom.emitDoubleClick(clickOnImage);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dom.input.value, "0be7f");
});

test("double-clicking the field fills and stops the page seeing it", async () => {
  const dom = createFakeDom();
  const page = createCaptchaPage({ recognize: async () => "e2c63" });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const clickOnField = doubleClickEvent(dom.input);
  dom.emitDoubleClick(clickOnField);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dom.input.value, "e2c63");
  assert.equal(clickOnField.prevented, true);
  assert.equal(clickOnField.stopped, true);
});

test("double-clicking elsewhere on the page does nothing", async () => {
  const dom = createFakeDom();
  const page = createCaptchaPage({ recognize: async () => "0be7f" });
  page.install();
  await new Promise((resolve) => setTimeout(resolve, 20));
  dom.input.value = "";

  const elsewhere = doubleClickEvent(new (globalThis.Element)());
  dom.emitDoubleClick(elsewhere);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dom.input.value, "");
  assert.equal(elsewhere.prevented, false);
});
