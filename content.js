(() => {
  "use strict";

  const MESSAGE_TYPE = "RTA_CAPTCHA_SOLVE";
  const CAPTCHA_IMAGE_SELECTOR = "img#verifyCodeMsg";
  const CAPTCHA_INPUT_SELECTOR = 'input#verifyCode[name="input-verify_code"]';
  const CAPTCHA_ORIGIN = "https://mansso.rta-os.com";
  const CAPTCHA_PATH = "/getVerifyCodeImg";
  const CAPTCHA_FLAG_PATTERN = /^[0-9a-f]{32}$/i;
  const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
  const MAX_AUTOMATIC_REFRESHES = 4;
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  let lastRequestedUrl = "";
  let activeGeneration = 0;
  let automaticRefreshes = 0;
  let scanQueued = false;

  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["src"],
    childList: true,
    subtree: true,
  });

  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLImageElement && event.target.matches(CAPTCHA_IMAGE_SELECTOR)) {
        queueScan();
      }
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (
        event.isTrusted &&
        event.target instanceof HTMLImageElement &&
        event.target.matches(CAPTCHA_IMAGE_SELECTOR)
      ) {
        automaticRefreshes = 0;
      }
    },
    true,
  );

  document.addEventListener(
    "input",
    (event) => {
      if (
        event.isTrusted &&
        event.target instanceof HTMLInputElement &&
        event.target.matches(CAPTCHA_INPUT_SELECTOR)
      ) {
        delete event.target.dataset[AUTOFILL_MARKER];
      }
    },
    true,
  );

  queueScan();

  function queueScan() {
    if (scanQueued) {
      return;
    }
    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      scanForCaptcha();
    });
  }

  function scanForCaptcha() {
    const image = document.querySelector(CAPTCHA_IMAGE_SELECTOR);
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      return;
    }

    const imageUrl = validatedCaptchaUrl(image.currentSrc || image.src);
    if (!imageUrl || !image.complete || image.naturalWidth <= 0) {
      return;
    }
    if (imageUrl === lastRequestedUrl) {
      return;
    }
    if (
      input.value.trim() !== "" &&
      input.dataset[AUTOFILL_MARKER] !== "true"
    ) {
      return;
    }

    lastRequestedUrl = imageUrl;
    activeGeneration += 1;
    const generation = activeGeneration;
    clearPreviousAutofill(input);
    void requestSolution(image, imageUrl, generation);
  }

  async function requestSolution(image, imageUrl, generation) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE,
        requestId: crypto.randomUUID(),
        imageUrl,
      });
    } catch {
      return;
    }

    if (
      generation !== activeGeneration ||
      validatedCaptchaUrl(image.currentSrc || image.src) !== imageUrl
    ) {
      return;
    }
    if (response?.ok === true && ANSWER_PATTERN.test(String(response.answer ?? ""))) {
      if (fillCaptchaInput(response.answer)) {
        automaticRefreshes = 0;
      }
      return;
    }
    if (response?.reason === "uncertain" || response?.reason === "unreadable") {
      refreshCaptcha(image);
    }
  }

  function getCaptchaInput() {
    const input = document.querySelector(CAPTCHA_INPUT_SELECTOR);
    if (
      !(input instanceof HTMLInputElement) ||
      input.id !== "verifyCode" ||
      input.name !== "input-verify_code" ||
      input.type.toLowerCase() !== "text" ||
      ["current-password", "new-password"].includes(input.autocomplete.toLowerCase())
    ) {
      return null;
    }
    return input;
  }

  function fillCaptchaInput(answer) {
    const input = getCaptchaInput();
    if (!input || !ANSWER_PATTERN.test(answer)) {
      return false;
    }
    const wasAutofilled = input.dataset[AUTOFILL_MARKER] === "true";
    if (input.value.trim() !== "" && !wasAutofilled) {
      return false;
    }
    setInputValue(input, answer);
    input.dataset[AUTOFILL_MARKER] = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function clearPreviousAutofill(input) {
    if (input.dataset[AUTOFILL_MARKER] !== "true") {
      return;
    }
    setInputValue(input, "");
    delete input.dataset[AUTOFILL_MARKER];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    if (typeof descriptor?.set === "function") {
      descriptor.set.call(input, value);
    }
  }

  function refreshCaptcha(image) {
    if (
      automaticRefreshes >= MAX_AUTOMATIC_REFRESHES ||
      !image.isConnected ||
      !image.matches(CAPTCHA_IMAGE_SELECTOR)
    ) {
      return;
    }
    automaticRefreshes += 1;
    image.click();
  }

  function validatedCaptchaUrl(value) {
    try {
      const url = new URL(value, location.href);
      const keys = [...url.searchParams.keys()];
      const flags = url.searchParams.getAll("verifyCodeFlag");
      if (
        url.origin !== CAPTCHA_ORIGIN ||
        url.pathname !== CAPTCHA_PATH ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        keys.length !== 1 ||
        keys[0] !== "verifyCodeFlag" ||
        flags.length !== 1 ||
        !CAPTCHA_FLAG_PATTERN.test(flags[0])
      ) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }
})();
