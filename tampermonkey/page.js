  const IMAGE_SELECTORS = [
    "img#verifyCodeMsg",
    'img[src*="getVerifyCodeImg"]',
    'img[src*="verifyCodeFlag"]',
  ];
  const INPUT_SELECTORS = [
    'input#verifyCode[name="input-verify_code"]',
    "input#verifyCode",
    'input[name="input-verify_code"]',
    'input[name="verifyCode"]',
    "input#verifycode",
  ];
  const FLAG_PATTERN = /^[0-9a-f]{32}$/i;
  const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  const solver = new EmbeddedOCRSolver();
  let activeGeneration = 0;

  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener(
    "input",
    (event) => {
      if (
        event.isTrusted &&
        event.target instanceof HTMLInputElement &&
        event.target === getCaptchaInput()
      ) {
        delete event.target.dataset[AUTOFILL_MARKER];
      }
    },
    true,
  );

  function onDoubleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const input = target.closest("input") || getCaptchaInput();
    const image = target.closest("img");
    const captchaInput = getCaptchaInput();
    const captchaImage = findCaptchaImage();
    const hitInput = captchaInput && (target === captchaInput || captchaInput.contains(target) || input === captchaInput);
    const hitImage = captchaImage && image === captchaImage;
    if (!hitInput && !hitImage) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void solveNow();
  }

  function solveNow() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement)) {
      setStatus("找不到驗證碼圖片", "error");
      return;
    }
    if (!input) {
      setStatus("找不到驗證碼輸入欄", "error");
      return;
    }
    if (!challengeUrl(image)) {
      setStatus("驗證碼圖片網址無法辨識", "error");
      return;
    }
    if (!image.complete || image.naturalWidth <= 0) {
      setStatus("驗證碼圖片尚未載入完成", "error");
      return;
    }
    activeGeneration += 1;
    const generation = activeGeneration;
    setStatus("正在辨識畫面上的驗證碼…");
    void requestSolution(image, generation);
  }

  async function requestSolution(image, generation) {
    try {
      const pixels = await readVisiblePixels(image);
      if (generation !== activeGeneration) {
        return;
      }
      const answer = solver.solve(pixels);
      if (generation !== activeGeneration) {
        return;
      }
      if (ANSWER_PATTERN.test(answer) && fillCaptchaInput(answer)) {
        setStatus(`已填入 ${answer}（未送出登入）。不對就換圖後再雙擊。`, "ok");
      }
      return;
    } catch (error) {
      if (generation !== activeGeneration) {
        return;
      }
      if (error && error.code === "uncertain") {
        setStatus("辨識不確定。請點驗證碼圖片換一張，再雙擊輸入欄。", "error");
        return;
      }
      setStatus(`無法辨識：${error && error.message ? error.message : error}`, "error");
    }
  }

  async function readVisiblePixels(image) {
    try {
      return readCanvasPixels(image);
    } catch {
      const url = challengeUrl(image);
      if (!url || url.startsWith("blob:")) {
        throw new Error("cannot read captcha pixels");
      }
      const bytes = await fetchCaptchaBytes(url);
      await showFetchedImage(image, url, bytes);
      return bytesToImageData(bytes);
    }
  }

  function readCanvasPixels(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width < 8 || height < 16) {
      throw new Error("captcha image is too small");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("canvas 2d context is unavailable");
    }
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height);
  }

  function showFetchedImage(image, originalUrl, bytes) {
    const blob = new Blob([bytes]);
    const blobUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("blob image load timed out"));
      }, 4000);
      function cleanup() {
        window.clearTimeout(timeout);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
      }
      function onLoad() {
        cleanup();
        resolve();
      }
      function onError() {
        cleanup();
        reject(new Error("blob image failed to load"));
      }
      image.dataset.rtaOcrOriginal = originalUrl;
      image.dataset.rtaOcrIgnoreLoad = "1";
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      image.src = blobUrl;
    });
  }

  function findCaptchaImage() {
    for (const selector of IMAGE_SELECTORS) {
      const image = document.querySelector(selector);
      if (image instanceof HTMLImageElement && isVisible(image)) {
        return image;
      }
    }
    for (const image of document.images) {
      if (!(image instanceof HTMLImageElement) || !isVisible(image)) {
        continue;
      }
      const blob = `${image.currentSrc || ""} ${image.src || ""} ${image.id} ${image.className} ${image.alt || ""} ${image.dataset.rtaOcrOriginal || ""}`;
      if (/getVerifyCodeImg|verifyCodeFlag|verifyCodeMsg|驗證碼|验证码/i.test(blob)) {
        return image;
      }
    }
    return null;
  }

  function getCaptchaInput() {
    for (const selector of INPUT_SELECTORS) {
      const input = document.querySelector(selector);
      if (isUsableCaptchaInput(input)) {
        return input;
      }
    }
    for (const input of document.querySelectorAll("input")) {
      if (!isUsableCaptchaInput(input)) {
        continue;
      }
      const blob = `${input.name} ${input.id} ${input.className} ${input.placeholder || ""} ${input.getAttribute("aria-label") || ""}`;
      if (/verify|captcha|驗證碼|验证码|驗証/i.test(blob)) {
        return input;
      }
    }
    return null;
  }

  function isUsableCaptchaInput(input) {
    if (!(input instanceof HTMLInputElement) || !isVisible(input) || input.disabled) {
      return false;
    }
    const type = (input.type || "text").toLowerCase();
    if (type === "password" || type === "hidden" || type === "email" || type === "submit") {
      return false;
    }
    const auto = (input.autocomplete || "").toLowerCase();
    if (auto === "current-password" || auto === "new-password") {
      return false;
    }
    return true;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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

  function fillCaptchaInput(answer) {
    const input = getCaptchaInput();
    if (!input || !ANSWER_PATTERN.test(answer)) {
      return false;
    }
    setInputValue(input, answer);
    input.dataset[AUTOFILL_MARKER] = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (typeof descriptor?.set === "function") {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
  }

  function challengeUrl(image) {
    if (!image) {
      return "";
    }
    return (
      validatedCaptchaUrl(image.currentSrc || image.src) ||
      image.dataset.rtaOcrOriginal ||
      ""
    );
  }

  function validatedCaptchaUrl(value) {
    if (!value) {
      return "";
    }
    try {
      const url = new URL(value, location.href);
      if (url.protocol === "blob:") {
        return "";
      }
      if (url.protocol !== "https:") {
        return "";
      }
      if (!/(^|\.)rta-os\.com$/i.test(url.hostname)) {
        return "";
      }
      const flag = url.searchParams.get("verifyCodeFlag");
      const looksLikeCaptcha =
        /getVerifyCodeImg/i.test(`${url.pathname}${url.search}`) || Boolean(flag);
      if (!looksLikeCaptcha) {
        return "";
      }
      if (flag && !FLAG_PATTERN.test(flag)) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function setStatus() {
    // No on-page overlay. Failures stay silent except the captcha field fill.
  }
