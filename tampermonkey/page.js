  const CAPTCHA_IMAGE_SELECTOR = "img#verifyCodeMsg";
  const CAPTCHA_INPUT_SELECTOR = 'input#verifyCode[name="input-verify_code"]';
  const CAPTCHA_ORIGIN = "https://mansso.rta-os.com";
  const CAPTCHA_PATH = "/getVerifyCodeImg";
  const CAPTCHA_FLAG_PATTERN = /^[0-9a-f]{32}$/i;
  const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
  const MAX_AUTOMATIC_REFRESHES = 4;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  const solver = new EmbeddedOCRSolver();
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
  window.addEventListener("hashchange", () => {
    lastRequestedUrl = "";
    queueScan();
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
    if (input.value.trim() !== "" && input.dataset[AUTOFILL_MARKER] !== "true") {
      return;
    }
    lastRequestedUrl = imageUrl;
    activeGeneration += 1;
    const generation = activeGeneration;
    clearPreviousAutofill(input);
    void requestSolution(image, imageUrl, generation);
  }

  async function requestSolution(image, imageUrl, generation) {
    let reason = "unreadable";
    try {
      const bytes = await fetchCaptchaBytes(imageUrl);
      const pixels = await bytesToImageData(bytes);
      const answer = solver.solve(pixels);
      if (
        generation !== activeGeneration ||
        validatedCaptchaUrl(image.currentSrc || image.src) !== imageUrl
      ) {
        return;
      }
      if (ANSWER_PATTERN.test(answer) && fillCaptchaInput(answer)) {
        automaticRefreshes = 0;
      }
      return;
    } catch (error) {
      reason = error && error.code === "uncertain" ? "uncertain" : "unreadable";
    }
    if (
      generation !== activeGeneration ||
      validatedCaptchaUrl(image.currentSrc || image.src) !== imageUrl
    ) {
      return;
    }
    if (reason === "uncertain" || reason === "unreadable") {
      refreshCaptcha(image);
    }
  }

  function gmRequest() {
    if (typeof GM_xmlhttpRequest === "function") {
      return GM_xmlhttpRequest;
    }
    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return GM.xmlHttpRequest;
    }
    return null;
  }

  function fetchCaptchaBytes(url) {
    const request = gmRequest();
    if (!request) {
      return Promise.reject(new Error("GM_xmlhttpRequest is unavailable"));
    }
    return new Promise((resolve, reject) => {
      request({
        method: "GET",
        url,
        responseType: "arraybuffer",
        anonymous: false,
        timeout: 12000,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`captcha HTTP ${response.status}`));
            return;
          }
          const buffer = response.response;
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            reject(new Error("empty captcha image"));
            return;
          }
          if (buffer.byteLength > MAX_IMAGE_BYTES) {
            reject(new Error("captcha image is too large"));
            return;
          }
          const bytes = new Uint8Array(buffer);
          if (!hasImageSignature(bytes)) {
            reject(new Error("captcha response is not an image"));
            return;
          }
          resolve(bytes);
        },
        onerror: () => reject(new Error("captcha request failed")),
        ontimeout: () => reject(new Error("captcha request timed out")),
      });
    });
  }

  function hasImageSignature(bytes) {
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png =
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47;
    const gif = bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
    const webp =
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
    return jpeg || png || gif || webp;
  }

  async function bytesToImageData(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("canvas 2d context is unavailable");
      }
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  function getCaptchaInput() {
    const input = document.querySelector(CAPTCHA_INPUT_SELECTOR);
    if (
      !(input instanceof HTMLInputElement) ||
      input.id !== "verifyCode" ||
      input.name !== "input-verify_code" ||
      input.type.toLowerCase() !== "text" ||
      ["current-password", "new-password"].includes((input.autocomplete || "").toLowerCase())
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
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (typeof descriptor?.set === "function") {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
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
