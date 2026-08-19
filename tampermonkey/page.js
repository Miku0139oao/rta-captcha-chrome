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
  const MAX_AUTOMATIC_REFRESHES = 4;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  const solver = new EmbeddedOCRSolver();
  let lastSolvedToken = "";
  let activeGeneration = 0;
  let automaticRefreshes = 0;
  let scanQueued = false;
  let statusNode = null;

  setStatus("RTA OCR 已載入，等待驗證碼…");
  const observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["src", "style", "class"],
    childList: true,
    subtree: true,
  });
  window.addEventListener("hashchange", () => {
    lastSolvedToken = "";
    automaticRefreshes = 0;
    queueScan();
  });
  window.addEventListener("popstate", () => queueScan());
  document.addEventListener(
    "load",
    (event) => {
      if (!(event.target instanceof HTMLImageElement)) {
        return;
      }
      const image = event.target;
      if (image.dataset.rtaOcrIgnoreLoad === "1") {
        delete image.dataset.rtaOcrIgnoreLoad;
        return;
      }
      if (findCaptchaImage() === image || challengeUrl(image)) {
        lastSolvedToken = "";
        queueScan();
      }
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      const image = event.target instanceof HTMLImageElement ? event.target : event.target.closest?.("img");
      if (!image || findCaptchaImage() !== image) {
        return;
      }
      automaticRefreshes = 0;
      lastSolvedToken = "";
      delete image.dataset.rtaOcrOriginal;
      clearPreviousAutofill(getCaptchaInput());
      setStatus("驗證碼已刷新，等待新圖…");
    },
    true,
  );
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
  queueScan();
  window.setInterval(queueScan, 1500);

  function queueScan() {
    if (scanQueued) {
      return;
    }
    scanQueued = true;
    window.setTimeout(() => {
      scanQueued = false;
      scanForCaptcha();
    }, 80);
  }

  function imageToken(image) {
    const src = image.currentSrc || image.src || "";
    return `${challengeUrl(image)}|${src}|${image.naturalWidth}x${image.naturalHeight}`;
  }

  function scanForCaptcha() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    if (!input) {
      setStatus("找到驗證碼圖，但還沒找到輸入欄");
      return;
    }
    if (!challengeUrl(image)) {
      setStatus("驗證碼圖片網址無法辨識");
      return;
    }
    if (!image.complete || image.naturalWidth <= 0) {
      return;
    }
    const token = imageToken(image);
    if (token === lastSolvedToken) {
      return;
    }
    if (input.value.trim() !== "" && input.dataset[AUTOFILL_MARKER] !== "true") {
      setStatus("驗證碼欄已有手動輸入，略過");
      return;
    }
    activeGeneration += 1;
    const generation = activeGeneration;
    clearPreviousAutofill(input);
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
        lastSolvedToken = imageToken(image);
        automaticRefreshes = 0;
        setStatus(`已填入 ${answer}（對應目前畫面，未送出登入）`, "ok");
      }
      return;
    } catch (error) {
      if (generation !== activeGeneration) {
        return;
      }
      if (error && error.code === "uncertain") {
        lastSolvedToken = imageToken(image);
        setStatus("辨識不確定，正在換圖…");
        refreshCaptcha(image);
        return;
      }
      setStatus(`無法辨識：${error && error.message ? error.message : error}`, "error");
      refreshCaptcha(image);
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
    if (!input || input.dataset[AUTOFILL_MARKER] !== "true") {
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
    if (automaticRefreshes >= MAX_AUTOMATIC_REFRESHES || !image.isConnected) {
      setStatus("多次不確定，請手動點驗證碼換圖", "error");
      return;
    }
    automaticRefreshes += 1;
    lastSolvedToken = "";
    delete image.dataset.rtaOcrOriginal;
    const clickTarget = document.getElementById("verifyCodeMsg") || image;
    if (typeof clickTarget.click === "function") {
      clickTarget.click();
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

  function setStatus(text, tone) {
    if (!document.body) {
      return;
    }
    if (!statusNode || !statusNode.isConnected) {
      statusNode = document.createElement("div");
      statusNode.id = "rta-captcha-ocr-status";
      statusNode.style.cssText = [
        "position:fixed",
        "right:12px",
        "bottom:12px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:8px 10px",
        "border-radius:8px",
        "font:12px/1.4 sans-serif",
        "box-shadow:0 2px 10px rgba(15,23,42,.18)",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(statusNode);
    }
    statusNode.textContent = text;
    statusNode.style.background = tone === "error" ? "#fef3c7" : tone === "ok" ? "#dcfce7" : "#e2e8f0";
    statusNode.style.color = "#0f172a";
  }
