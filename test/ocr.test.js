import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEARNED_GLYPH_TEMPLATES,
  LEARNED_GLYPH_TEMPLATES_TOPOLOGY,
} from "../ocr/templates.generated.js";
import {
  DEFAULT_OCR_ALPHABET,
  EmbeddedOCRSolver,
  OCRInputError,
  OCRUncertainError,
  TEMPLATE_HEIGHT,
  TEMPLATE_WIDTH,
  __testing,
} from "../ocr/solver.js";

function syntheticCaptcha(answer) {
  const width = answer.length * 20;
  const height = 30;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  const palette = [
    [40, 105, 170],
    [150, 45, 75],
    [55, 130, 70],
    [105, 55, 155],
    [165, 105, 25],
  ];

  for (let index = 0; index < answer.length; index += 1) {
    const character = answer[index];
    const glyph = __testing.decodeGlyphTemplates(
      LEARNED_GLYPH_TEMPLATES[character],
    )[0];
    assert.ok(glyph, `missing template for ${character}`);
    for (let y = 0; y < glyph.height; y += 1) {
      for (let x = 0; x < glyph.width; x += 1) {
        if (!glyph.at(x, y)) {
          continue;
        }
        const position = ((4 + y) * width + index * 20 + 3 + x) * 4;
        data[position] = palette[index][0];
        data[position + 1] = palette[index][1];
        data[position + 2] = palette[index][2];
        data[position + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

function loadRGBAFixture(name) {
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    name,
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  return {
    width: fixture.width,
    height: fixture.height,
    data: new Uint8ClampedArray(Buffer.from(fixture.rgbaBase64, "base64")),
  };
}

test("embedded OCR solves the Go reference synthetic captcha", () => {
  const solver = new EmbeddedOCRSolver();
  assert.equal(solver.solve(loadRGBAFixture("synthetic-0be7f.json")), "0be7f");
});

test("consensus review recovers the upstream color-noise captcha", () => {
  const solver = new EmbeddedOCRSolver();
  assert.equal(solver.solve(loadRGBAFixture("color-noise-e2c63.json")), "e2c63");
});

test("embedded OCR has every hexadecimal template in both models", () => {
  const solver = new EmbeddedOCRSolver();
  assert.equal(solver.maximumDistance, 0.2);
  assert.equal(solver.minimumScoreMargin, 0.02);
  for (const character of DEFAULT_OCR_ALPHABET) {
    assert.ok(solver.templates[character].length > 0, character);
    assert.ok(solver.fittedTemplates[character].length > 0, character);
  }
});

test("precomputed topology hints match a fresh walk of the bitmap", () => {
  // The generator ships a topology hint per template so the runtime does not have
  // to flood-fill 8.8k bitmaps on start-up. A hint that ever disagreed with the
  // bitmap would silently change distance scoring, so verify all of them.
  let checked = 0;
  for (const character of DEFAULT_OCR_ALPHABET) {
    const templates = LEARNED_GLYPH_TEMPLATES[character];
    const hints = LEARNED_GLYPH_TEMPLATES_TOPOLOGY[character];
    assert.equal(hints.length, templates.length, character);
    const glyphs = __testing.decodeGlyphTemplates(templates);
    for (let index = 0; index < glyphs.length; index += 1) {
      const expected = __testing.inspectGlyphTopology(glyphs[index]);
      const hint = hints[index];
      assert.equal(hint[0], String(expected.holes), character + "#" + index + " holes");
      assert.equal(
        hint[1],
        expected.rightOpening ? "1" : "0",
        character + "#" + index + " right",
      );
      assert.equal(
        hint[2],
        expected.leftOpening ? "1" : "0",
        character + "#" + index + " left",
      );
      checked += 1;
    }
  }
  assert.ok(checked > 1000, "only checked " + checked + " templates");
});

test("a solve classifies each distinct glyph only once", () => {
  // Baseline and ensemble used to classify the same normalised bitmap four times
  // per character. Memoisation must be observable and must not change answers.
  const solver = new EmbeddedOCRSolver();
  const image = loadRGBAFixture("color-noise-e2c63.json");
  let uncached = 0;
  const original = solver.classifyUncached.bind(solver);
  solver.classifyUncached = (glyph, templates) => {
    uncached += 1;
    return original(glyph, templates);
  };
  assert.equal(solver.solve(image), "e2c63");
  assert.equal(uncached, solver.classificationMemo.size);
  assert.ok(uncached <= 40, "expected at most 40 classifications, saw " + uncached);
});

test("repeated solves stay fast and deterministic", () => {
  const solver = new EmbeddedOCRSolver();
  const image = loadRGBAFixture("color-noise-e2c63.json");
  solver.solve(image);
  const timings = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    assert.equal(solver.solve(image), "e2c63");
    timings.push(performance.now() - started);
  }
  timings.sort((left, right) => left - right);
  // The memo-free implementation took ~260 ms per solve; leave generous headroom
  // for slow CI machines while still catching a regression to the old cost.
  assert.ok(timings[2] < 120, "median solve was " + timings[2].toFixed(1) + " ms");
});

test("acceptMatch allows a farther hit only when the runner-up is clearly worse", () => {
  const solver = new EmbeddedOCRSolver();
  assert.equal(solver.acceptMatch(0.19, 0.02), true);
  assert.equal(solver.acceptMatch(0.21, 0.08), true);
  assert.equal(solver.acceptMatch(0.21, 0.03), false);
  assert.equal(solver.acceptMatch(0.26, 0.2), false);
  assert.equal(solver.acceptMatch(0.1, -1), false);
});

test("resolveModelDisagreement keeps a clearly closer model", () => {
  const solver = new EmbeddedOCRSolver();
  const stretched = solver.resolveModelDisagreement(
    { character: "8", distance: 0.05, margin: 0.02 },
    { character: "0", distance: 0.2, margin: 0.02 },
  );
  assert.equal(stretched.character, "8");
  assert.ok(stretched.margin > 0.14);

  const rejected = solver.resolveModelDisagreement(
    { character: "8", distance: 0.11, margin: 0.02 },
    { character: "0", distance: 0.13, margin: 0.02 },
  );
  assert.equal(rejected.margin, -1);
});

test("embedded OCR rejects uncertain output instead of guessing", () => {
  const solver = new EmbeddedOCRSolver({
    maximumDistance: 2,
    minimumScoreMargin: 2,
  });
  assert.throws(
    () => solver.solve(syntheticCaptcha("0be7f")),
    (error) => error instanceof OCRUncertainError && error.code === "uncertain",
  );
});

test("embedded OCR validates RGBA input and minimum dimensions", () => {
  const solver = new EmbeddedOCRSolver();
  assert.throws(
    () => solver.solve({ width: 10, height: 20, data: new Uint8Array(3) }),
    (error) => error instanceof OCRInputError && error.code === "invalid-image",
  );
  assert.throws(
    () =>
      solver.solve({
        width: 8,
        height: 8,
        data: new Uint8ClampedArray(8 * 8 * 4),
      }),
    (error) => error instanceof OCRInputError && error.code === "too-small",
  );
});

test("topology separates open and closed hexadecimal glyphs", () => {
  const zero = __testing.decodeGlyphTemplates(LEARNED_GLYPH_TEMPLATES["0"])[0];
  const cee = __testing.decodeGlyphTemplates(LEARNED_GLYPH_TEMPLATES.c)[0];
  const three = __testing.decodeGlyphTemplates(LEARNED_GLYPH_TEMPLATES["3"])[0];
  const zeroTopology = __testing.inspectGlyphTopology(zero);
  const ceeTopology = __testing.inspectGlyphTopology(cee);
  const threeTopology = __testing.inspectGlyphTopology(three);

  assert.ok(zeroTopology.holes >= 1);
  assert.ok(ceeTopology.rightOpening || ceeTopology.holes === 0);
  assert.ok(threeTopology.leftOpening || threeTopology.holes === 0);
  assert.equal(__testing.topologyAgrees("0", ceeTopology), false);
  assert.equal(__testing.topologyAgrees("c", ceeTopology), true);
});

test("best extraction selection penalizes cross-extraction disagreement", () => {
  const strongest = __testing.selectBestGlyphMatch([
    { character: "5", distance: 0.166, margin: 0.03 },
    { character: "2", distance: 0.093, margin: 0.119 },
  ]);
  assert.equal(strongest.character, "2");
  assert.ok(Math.abs(strongest.distance - 0.093) < 1e-12);
  assert.ok(Math.abs(strongest.margin - 0.073) < 1e-12);

  const close = __testing.selectBestGlyphMatch([
    { character: "e", distance: 0.158, margin: 0.04 },
    { character: "a", distance: 0.162, margin: 0.08 },
  ]);
  assert.equal(close.character, "e");
  assert.ok(close.margin > 0.0039 && close.margin < 0.0041);
});

test("packed overlap distance matches a pixel reference implementation", () => {
  let state = 0x20260814;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let sample = 0; sample < 100; sample += 1) {
    const left = new __testing.BinaryGlyph(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
    const right = new __testing.BinaryGlyph(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
    for (let position = 0; position < left.pixels.length; position += 1) {
      left.pixels[position] = random() % 4 === 0 ? 1 : 0;
      right.pixels[position] = random() % 4 === 0 ? 1 : 0;
    }
    const preparedLeft = __testing.prepareGlyph(left);
    const preparedRight = __testing.prepareGlyph(right);
    const actual = __testing.alignedGlyphOverlapDistance(
      preparedLeft,
      preparedRight,
    );
    const expected = referenceOverlapDistance(preparedLeft, preparedRight);
    assert.ok(Math.abs(actual - expected) < 1e-12, `sample ${sample}`);
  }
});

function referenceOverlapDistance(left, right) {
  let best = 1;
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      let intersection = 0;
      for (const position of left.foreground) {
        const x = (position % left.glyph.width) + offsetX;
        const y = Math.trunc(position / left.glyph.width) + offsetY;
        if (right.glyph.at(x, y)) {
          intersection += 1;
        }
      }
      best = Math.min(
        best,
        1 -
          (2 * intersection) /
            (left.foreground.length + right.foreground.length),
      );
    }
  }
  return best;
}
