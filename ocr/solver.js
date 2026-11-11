import {
  FITTED_GLYPH_TEMPLATES,
  FITTED_GLYPH_TEMPLATES_TOPOLOGY,
  LEARNED_GLYPH_TEMPLATES,
  LEARNED_GLYPH_TEMPLATES_TOPOLOGY,
  SUPPLEMENTAL_GLYPH_TEMPLATES,
  SUPPLEMENTAL_GLYPH_TEMPLATES_TOPOLOGY,
  TRAINED_FITTED_GLYPH_TEMPLATES,
  TRAINED_FITTED_GLYPH_TEMPLATES_TOPOLOGY,
  TRAINED_GLYPH_TEMPLATES,
  TRAINED_GLYPH_TEMPLATES_TOPOLOGY,
} from "./templates.generated.js";
import {
  BinaryGlyph,
  TEMPLATE_HEIGHT,
  TEMPLATE_WIDTH,
  alignedGlyphOverlapDistance,
  decodeGlyphTemplate,
  decodeGlyphTemplates,
  decodeGlyphTopology,
  glyphDistance,
  inspectGlyphTopology,
  prepareGlyph,
  prepareGlyphTemplates,
  topologyAgrees,
} from "../lib/glyph.js";

export const DEFAULT_OCR_ALPHABET = "0123456789abcdef";
export const DEFAULT_OCR_LENGTH = 5;
export { TEMPLATE_HEIGHT, TEMPLATE_WIDTH };

const DEFAULT_MAXIMUM_DISTANCE = 0.2;
const DEFAULT_MINIMUM_SCORE_MARGIN = 0.02;

// The template file ships a parallel topology hint (three flag characters:
// hole count, right opening, left opening) for every template. Older exports did
// not; those fall back to computing the topology from the bitmap.
const TOPOLOGY_HINT_PATTERN = /^[0-9][01][01]$/;
const TEMPLATE_MEMO_LIMIT = 512;

export class OCRInputError extends Error {
  constructor(message, code = "invalid-input") {
    super(message);
    this.name = "OCRInputError";
    this.code = code;
  }
}

export class OCRUncertainError extends Error {
  constructor(characterIndex, distance, margin) {
    super(
      `Captcha character ${characterIndex + 1} is uncertain ` +
        `(distance ${distance.toFixed(3)}, margin ${margin.toFixed(3)})`,
    );
    this.name = "OCRUncertainError";
    this.code = "uncertain";
    this.characterIndex = characterIndex;
    this.distance = distance;
    this.margin = margin;
  }
}

let preparedTemplateCache;

function getPreparedTemplateCache() {
  if (preparedTemplateCache) {
    return preparedTemplateCache;
  }

  const stretched = {};
  const fitted = {};
  for (const character of DEFAULT_OCR_ALPHABET) {
    stretched[character] = prepareEncodedTemplates(
      [
        [LEARNED_GLYPH_TEMPLATES, LEARNED_GLYPH_TEMPLATES_TOPOLOGY],
        [SUPPLEMENTAL_GLYPH_TEMPLATES, SUPPLEMENTAL_GLYPH_TEMPLATES_TOPOLOGY],
        [TRAINED_GLYPH_TEMPLATES, TRAINED_GLYPH_TEMPLATES_TOPOLOGY],
      ],
      character,
    );
    fitted[character] = prepareEncodedTemplates(
      [
        [FITTED_GLYPH_TEMPLATES, FITTED_GLYPH_TEMPLATES_TOPOLOGY],
        [
          TRAINED_FITTED_GLYPH_TEMPLATES,
          TRAINED_FITTED_GLYPH_TEMPLATES_TOPOLOGY,
        ],
      ],
      character,
    );
  }
  preparedTemplateCache = { stretched, fitted };
  return preparedTemplateCache;
}

function prepareEncodedTemplates(sources, character) {
  const glyphs = [];
  const topologies = [];
  for (const [templates, topologyHints] of sources) {
    const encodedTemplates = templateList(templates, character);
    const hints = templateList(topologyHints, character);
    for (let index = 0; index < encodedTemplates.length; index += 1) {
      glyphs.push(decodeGlyphTemplate(encodedTemplates[index]));
      const hint = hints[index];
      topologies.push(
        typeof hint === "string" && TOPOLOGY_HINT_PATTERN.test(hint)
          ? decodeGlyphTopology(hint)
          : undefined,
      );
    }
  }
  return prepareGlyphTemplates(glyphs, topologies);
}

export class EmbeddedOCRSolver {
  constructor(config = {}) {
    this.length =
      Number.isInteger(config.length) && config.length > 0
        ? config.length
        : DEFAULT_OCR_LENGTH;
    this.alphabet = uniqueASCII(
      String(config.alphabet ?? "").trim().toLowerCase(),
    );
    if (this.alphabet === "") {
      this.alphabet = DEFAULT_OCR_ALPHABET;
    }
    this.maximumDistance = positiveNumberOrDefault(
      config.maximumDistance,
      DEFAULT_MAXIMUM_DISTANCE,
    );
    this.minimumScoreMargin = positiveNumberOrDefault(
      config.minimumScoreMargin,
      DEFAULT_MINIMUM_SCORE_MARGIN,
    );

    const prepared = getPreparedTemplateCache();
    this.templates = selectTemplateAlphabet(prepared.stretched, this.alphabet);
    this.fittedTemplates = selectTemplateAlphabet(
      prepared.fitted,
      this.alphabet,
    );

    // A captcha character is classified up to four times per solve: twice for
    // the baseline (stretched + fitted) and twice again for the ensemble vote on
    // the same extracted components. Classification is a pure function of the
    // glyph bitmap, so memoising it removes ~90% of the work without changing a
    // single decision.
    this.classificationMemo = new Map();
    this.componentCache = null;
  }

  solve(source) {
    validateRGBAImage(source);
    if (source.width < this.length * 8 || source.height < 16) {
      throw new OCRInputError(
        `Captcha image is too small: ${source.width}x${source.height}`,
        "too-small",
      );
    }

    this.componentCache = new Map();
    let answer = "";
    for (let index = 0; index < this.length; index += 1) {
      const match = this.classifyCaptchaCharacter(source, index);
      if (!this.acceptMatch(match.distance, match.margin)) {
        throw new OCRUncertainError(index, match.distance, match.margin);
      }
      answer += match.character;
    }
    this.componentCache = null;
    return answer;
  }

  classifyCaptchaCharacter(source, index) {
    const baseline = this.classifyCaptchaCharacterBaseline(source, index);
    if (
      baseline.distance <= Math.min(0.15, this.maximumDistance) &&
      baseline.margin >= Math.max(0.05, this.minimumScoreMargin) &&
      this.topologySupports(source, index, baseline.character)
    ) {
      return baseline;
    }

    let components;
    try {
      components = this.ensembleComponents(source, index);
    } catch {
      return baseline;
    }
    const { winner, runnerVotes } = this.classifyGlyphEnsemble(components);
    if (
      winner.character === "" ||
      winner.modelMask !== 3 ||
      winner.votes - runnerVotes < 1
    ) {
      return baseline;
    }

    const distance = Math.max(...winner.bestDistance);
    const margin = Math.min(...winner.bestMargin);
    if (!this.acceptMatch(distance, margin)) {
      return baseline;
    }
    return { character: winner.character, distance, margin };
  }

  acceptMatch(distance, margin) {
    if (margin < 0 || !Number.isFinite(distance)) {
      return false;
    }
    if (distance <= this.maximumDistance && margin >= this.minimumScoreMargin) {
      return true;
    }
    // Farther template is safe only when the runner-up is clearly worse.
    return (
      distance <= this.maximumDistance + 0.05 &&
      margin >= this.minimumScoreMargin + 0.05
    );
  }

  topologySupports(source, index, character) {
    if (character === "") {
      return false;
    }
    let components;
    try {
      components = this.ensembleComponents(source, index);
    } catch {
      try {
        components = extractCaptchaGlyphComponents(
          source,
          index,
          this.length,
          0,
        );
      } catch {
        return true;
      }
    }
    if (components.length === 0) {
      return true;
    }

    let agreements = 0;
    for (const component of components) {
      if (topologyAgrees(character, inspectGlyphTopology(component))) {
        agreements += 1;
      }
    }
    return agreements * 2 >= components.length;
  }

  // Extraction is also pure per (source, index): a solve extracts the same cell
  // at most three times (baseline, topology check, ensemble vote).
  ensembleComponents(source, index) {
    const cached = this.componentCache?.get(index);
    if (cached) {
      return cached;
    }
    const components = extractCaptchaGlyphEnsembleComponents(
      source,
      index,
      this.length,
    );
    this.componentCache?.set(index, components);
    return components;
  }

  classifyCaptchaCharacterBaseline(source, index) {
    const components = extractCaptchaGlyphComponents(
      source,
      index,
      this.length,
      0,
    );
    const stretchedMatches = [];
    const fittedMatches = [];
    for (const component of components) {
      stretchedMatches.push(
        this.classify(normalizeGlyph(component, TEMPLATE_WIDTH, TEMPLATE_HEIGHT)),
      );
      fittedMatches.push(
        this.classifyWithTemplates(
          normalizeGlyphPreservingAspect(
            component,
            TEMPLATE_WIDTH,
            TEMPLATE_HEIGHT,
          ),
          this.fittedTemplates,
        ),
      );
    }

    const stretched = selectBestGlyphMatch(stretchedMatches);
    const fitted = selectBestGlyphMatch(fittedMatches);
    if (stretched.character !== fitted.character) {
      return this.resolveModelDisagreement(stretched, fitted);
    }
    return {
      character: stretched.character,
      distance: Math.max(stretched.distance, fitted.distance),
      margin: Math.min(stretched.margin, fitted.margin),
    };
  }

  resolveModelDisagreement(stretched, fitted) {
    const reject = {
      character: stretched.character,
      distance: Math.max(stretched.distance, fitted.distance),
      margin: -1,
    };
    if (stretched.distance + 0.08 <= fitted.distance && stretched.distance <= 0.12) {
      return {
        character: stretched.character,
        distance: stretched.distance,
        margin: fitted.distance - stretched.distance,
      };
    }
    if (fitted.distance + 0.08 <= stretched.distance && fitted.distance <= 0.12) {
      return {
        character: fitted.character,
        distance: fitted.distance,
        margin: stretched.distance - fitted.distance,
      };
    }
    return reject;
  }

  classifyGlyphEnsemble(components) {
    const votes = [];
    for (const component of components) {
      votes.push({
        ...this.classify(
          normalizeGlyph(component, TEMPLATE_WIDTH, TEMPLATE_HEIGHT),
        ),
        model: 0,
      });
      votes.push({
        ...this.classifyWithTemplates(
          normalizeGlyphPreservingAspect(
            component,
            TEMPLATE_WIDTH,
            TEMPLATE_HEIGHT,
          ),
          this.fittedTemplates,
        ),
        model: 1,
      });
    }

    const byCharacter = new Map();
    for (const vote of votes) {
      let score = byCharacter.get(vote.character);
      if (!score) {
        score = {
          character: vote.character,
          votes: 0,
          modelMask: 0,
          quality: 0,
          bestDistance: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
          bestMargin: [0, 0],
        };
        byCharacter.set(vote.character, score);
      }
      score.votes += 1;
      score.modelMask |= 1 << vote.model;
      score.quality +=
        Math.max(0, vote.margin) + Math.max(0, 0.25 - vote.distance);
      if (vote.distance < score.bestDistance[vote.model]) {
        score.bestDistance[vote.model] = vote.distance;
        score.bestMargin[vote.model] = vote.margin;
      }
    }

    const scores = [...byCharacter.values()].sort(compareVoteScores);
    return {
      winner: scores[0] ?? emptyVoteScore(),
      runnerVotes: scores[1]?.votes ?? 0,
    };
  }

  classify(glyph) {
    return this.classifyWithTemplates(glyph, this.templates);
  }

  classifyWithTemplates(glyph, templates) {
    const key = (templates === this.templates ? "s" : "f") + glyphKey(glyph);
    const memoized = this.classificationMemo.get(key);
    if (memoized) {
      return memoized;
    }
    const result = this.classifyUncached(glyph, templates);
    if (this.classificationMemo.size >= TEMPLATE_MEMO_LIMIT) {
      this.classificationMemo.clear();
    }
    this.classificationMemo.set(key, result);
    return result;
  }

  classifyUncached(glyph, templates) {
    const candidates = [];
    const prepared = prepareGlyph(glyph);
    for (const character of this.alphabet) {
      const nearest = [
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ];
      for (const template of templates[character]) {
        const distance = glyphDistance(prepared, template);
        for (let neighbor = 0; neighbor < nearest.length; neighbor += 1) {
          if (distance >= nearest[neighbor]) {
            continue;
          }
          for (let shift = nearest.length - 1; shift > neighbor; shift -= 1) {
            nearest[shift] = nearest[shift - 1];
          }
          nearest[neighbor] = distance;
          break;
        }
      }

      const finite = nearest.filter(Number.isFinite);
      const distance =
        finite.length === 0
          ? Number.POSITIVE_INFINITY
          : finite.reduce((sum, value) => sum + value, 0) / finite.length;
      candidates.push({ character, distance });
    }

    candidates.sort((left, right) => {
      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }
      return left.character.localeCompare(right.character);
    });
    if (candidates.length === 0) {
      return {
        character: "",
        distance: Number.POSITIVE_INFINITY,
        margin: 0,
      };
    }
    const margin =
      candidates.length > 1
        ? candidates[1].distance - candidates[0].distance
        : Number.POSITIVE_INFINITY;
    return { ...candidates[0], margin };
  }
}

// Compact, collision-resistant key for a normalised glyph bitmap. Templates are
// 15x21 so a 32 bit FNV-1a over the packed rows is enough to make an accidental
// collision negligible, and the width/height are folded in as well.
function glyphKey(glyph) {
  let hash = 0x811c9dc5;
  for (let position = 0; position < glyph.pixels.length; position += 1) {
    if (glyph.pixels[position] === 0) {
      continue;
    }
    hash = Math.imul(hash ^ position, 0x01000193) >>> 0;
  }
  return `${glyph.width}x${glyph.height}:${hash}`;
}

function positiveNumberOrDefault(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function validateRGBAImage(source) {
  if (
    !source ||
    !Number.isInteger(source.width) ||
    !Number.isInteger(source.height) ||
    source.width <= 0 ||
    source.height <= 0 ||
    !(source.data instanceof Uint8Array ||
      source.data instanceof Uint8ClampedArray) ||
    source.data.length !== source.width * source.height * 4
  ) {
    throw new OCRInputError("Expected a complete RGBA image", "invalid-image");
  }
}

function selectTemplateAlphabet(source, alphabet) {
  const result = {};
  for (const character of alphabet) {
    result[character] = source[character] ?? [];
  }
  return result;
}

function uniqueASCII(value) {
  const seen = new Set();
  let result = "";
  for (const character of value) {
    if (
      character.charCodeAt(0) > 127 ||
      seen.has(character) ||
      !LEARNED_GLYPH_TEMPLATES[character]
    ) {
      continue;
    }
    seen.add(character);
    result += character;
  }
  return result;
}

function selectBestGlyphMatch(input) {
  if (input.length === 0) {
    return {
      character: "",
      distance: Number.POSITIVE_INFINITY,
      margin: 0,
    };
  }
  const matches = [...input].sort((left, right) => {
    if (left.distance === right.distance) {
      return right.margin - left.margin;
    }
    return left.distance - right.distance;
  });
  const best = { ...matches[0] };
  for (const alternative of matches.slice(1)) {
    if (alternative.character !== best.character) {
      best.margin = Math.min(
        best.margin,
        alternative.distance - best.distance,
      );
    }
  }
  return best;
}

function compareVoteScores(left, right) {
  if (left.votes !== right.votes) {
    return right.votes - left.votes;
  }
  if (left.modelMask !== right.modelMask) {
    return right.modelMask - left.modelMask;
  }
  if (left.quality !== right.quality) {
    return right.quality - left.quality;
  }
  return left.character.localeCompare(right.character);
}

function emptyVoteScore() {
  return {
    character: "",
    votes: 0,
    modelMask: 0,
    quality: 0,
    bestDistance: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    bestMargin: [0, 0],
  };
}

function extractCaptchaGlyphComponents(source, index, length, horizontalInset) {
  const left = Math.round((index * source.width) / length) + horizontalInset;
  const right =
    Math.round(((index + 1) * source.width) / length) - horizontalInset;
  const top = 3;
  const bottom = source.height - 3;
  if (right - left < 4 || bottom - top < 8) {
    throw new OCRInputError("Invalid captcha cell bounds", "invalid-cell");
  }
  const bounds = { left, right, top, bottom };
  const components = [];
  const dominant = dominantColorComponent(source, bounds);
  if (dominant && dominant.foregroundCount() >= 18) {
    components.push(dominant);
  }
  try {
    components.push(grayscaleCaptchaComponent(source, bounds));
  } catch {
    // The color extraction can still be usable on its own.
  }
  if (components.length === 0) {
    throw new OCRInputError("No usable glyph component", "no-component");
  }
  return components;
}

function extractCaptchaGlyphEnsembleComponents(source, index, length) {
  const left = Math.round((index * source.width) / length);
  const right = Math.round(((index + 1) * source.width) / length);
  const top = 3;
  const bottom = source.height - 3;
  if (right - left < 4 || bottom - top < 8) {
    throw new OCRInputError("Invalid captcha cell bounds", "invalid-cell");
  }
  const bounds = { left, right, top, bottom };
  const components = [];
  for (const tolerance of [0.035, 0.05, 0.07, 0.09, 0.11]) {
    const component = dominantColorComponentWithTolerance(
      source,
      bounds,
      tolerance,
    );
    if (component && component.foregroundCount() >= 18) {
      appendUniqueGlyphComponent(components, component);
    }
  }
  try {
    appendUniqueGlyphComponent(
      components,
      grayscaleCaptchaComponent(source, bounds),
    );
  } catch {
    // Color ensemble components can still be usable.
  }
  if (components.length === 0) {
    throw new OCRInputError("No usable glyph component", "no-component");
  }
  return components;
}

function appendUniqueGlyphComponent(components, candidate) {
  if (!components.some((existing) => equalBinaryGlyph(existing, candidate))) {
    components.push(candidate);
  }
  return components;
}

function equalBinaryGlyph(left, right) {
  if (
    left.width !== right.width ||
    left.height !== right.height ||
    left.pixels.length !== right.pixels.length
  ) {
    return false;
  }
  for (let position = 0; position < left.pixels.length; position += 1) {
    if (left.pixels[position] !== right.pixels[position]) {
      return false;
    }
  }
  return true;
}

function dominantColorComponent(source, bounds) {
  return dominantColorComponentWithTolerance(source, bounds, 0.11);
}

function dominantColorComponentWithTolerance(source, bounds, colorTolerance) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const clusters = new Map();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = colorDeficit(
        source,
        bounds.left + x,
        bounds.top + y,
      );
      const total = red + green + blue;
      const strength = Math.max(red, green, blue);
      if (strength < 24 || total <= 0) {
        continue;
      }
      const normalizedRed = red / total;
      const normalizedGreen = green / total;
      const key = `${Math.round(normalizedRed * 12)},${Math.round(
        normalizedGreen * 12,
      )}`;
      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = { red: 0, green: 0, blue: 0, weight: 0, count: 0 };
        clusters.set(key, cluster);
      }
      const weight = Math.min(strength, 160) / 160;
      cluster.red += normalizedRed * weight;
      cluster.green += normalizedGreen * weight;
      cluster.blue += (blue / total) * weight;
      cluster.weight += weight;
      cluster.count += 1;
    }
  }

  const candidates = [];
  for (const cluster of clusters.values()) {
    if (cluster.count < 4 || cluster.weight === 0) {
      continue;
    }
    candidates.push({
      ...cluster,
      red: cluster.red / cluster.weight,
      green: cluster.green / cluster.weight,
      blue: cluster.blue / cluster.weight,
    });
  }
  candidates.sort((left, right) => {
    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }
    if (left.red !== right.red) {
      return left.red - right.red;
    }
    return left.green - right.green;
  });

  let bestScore = -1;
  let best = null;
  for (const candidate of candidates.slice(0, 10)) {
    const mask = new BinaryGlyph(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let [red, green, blue] = colorDeficit(
          source,
          bounds.left + x,
          bounds.top + y,
        );
        const total = red + green + blue;
        const strength = Math.max(red, green, blue);
        if (strength < 20 || total <= 0) {
          continue;
        }
        red /= total;
        green /= total;
        blue /= total;
        const difference =
          Math.abs(red - candidate.red) +
          Math.abs(green - candidate.green) +
          Math.abs(blue - candidate.blue);
        if (difference <= colorTolerance) {
          mask.set(x, y, true);
        }
      }
    }

    const component = largestComponent(removeThinLines(mask));
    if (!component) {
      continue;
    }
    const count = component.foregroundCount();
    if (count < 12 || component.height < 10) {
      continue;
    }
    const aspectPenalty =
      component.width > Math.ceil(width * 0.9)
        ? (component.width - Math.trunc(width / 2)) * 2
        : 0;
    const score = count + component.height * 3 - aspectPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = component;
    }
  }
  return best;
}

function colorDeficit(source, x, y) {
  const position = (y * source.width + x) * 4;
  return [
    255 - source.data[position],
    255 - source.data[position + 1],
    255 - source.data[position + 2],
  ];
}

function grayscaleCaptchaComponent(source, bounds) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const gray = new Uint8Array(width * height);
  const histogram = new Int32Array(256);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourcePosition =
        ((bounds.top + y) * source.width + bounds.left + x) * 4;
      const value = Math.trunc(
        (299 * source.data[sourcePosition] +
          587 * source.data[sourcePosition + 1] +
          114 * source.data[sourcePosition + 2]) /
          1000,
      );
      gray[y * width + x] = value;
      histogram[value] += 1;
    }
  }

  const threshold = Math.max(
    105,
    Math.min(185, otsuThreshold(histogram, width * height)),
  );
  const raw = new BinaryGlyph(width, height);
  for (let position = 0; position < gray.length; position += 1) {
    raw.pixels[position] = gray[position] <= threshold ? 1 : 0;
  }
  const component = largestComponent(removeThinLines(raw));
  if (!component || component.foregroundCount() < 18) {
    throw new OCRInputError("No usable glyph component", "no-component");
  }
  return component;
}

function otsuThreshold(histogram, total) {
  if (total <= 0) {
    return 150;
  }
  let sum = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    sum += value * histogram[value];
  }
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 150;
  for (let threshold = 0; threshold < 256; threshold += 1) {
    backgroundWeight += histogram[threshold];
    if (backgroundWeight === 0) {
      continue;
    }
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) {
      break;
    }
    backgroundSum += threshold * histogram[threshold];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const difference = backgroundMean - foregroundMean;
    const variance =
      backgroundWeight * foregroundWeight * difference * difference;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

function removeThinLines(source) {
  const core = new BinaryGlyph(source.width, source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (!source.at(x, y)) {
        continue;
      }
      for (let top = y - 1; top <= y; top += 1) {
        for (let left = x - 1; left <= x; left += 1) {
          if (
            source.at(left, top) &&
            source.at(left + 1, top) &&
            source.at(left, top + 1) &&
            source.at(left + 1, top + 1)
          ) {
            core.set(x, y, true);
          }
        }
      }
    }
  }

  const result = new BinaryGlyph(source.width, source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (!core.at(x, y)) {
        continue;
      }
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (source.at(x + offsetX, y + offsetY)) {
            result.set(x + offsetX, y + offsetY, true);
          }
        }
      }
    }
  }
  return result;
}

function largestComponent(source) {
  const visited = new Uint8Array(source.pixels.length);
  let best = [];
  for (let start = 0; start < source.pixels.length; start += 1) {
    if (source.pixels[start] === 0 || visited[start] !== 0) {
      continue;
    }
    const queue = [start];
    visited[start] = 1;
    const component = [];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const position = queue[cursor];
      component.push(position);
      const x = position % source.width;
      const y = Math.trunc(position / source.width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) {
            continue;
          }
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (
            nextX < 0 ||
            nextX >= source.width ||
            nextY < 0 ||
            nextY >= source.height
          ) {
            continue;
          }
          const next = nextY * source.width + nextX;
          if (source.pixels[next] !== 0 && visited[next] === 0) {
            visited[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    if (component.length > best.length) {
      best = component;
    }
  }
  if (best.length === 0) {
    return null;
  }

  let left = source.width;
  let right = -1;
  let top = source.height;
  let bottom = -1;
  for (const position of best) {
    const x = position % source.width;
    const y = Math.trunc(position / source.width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const result = new BinaryGlyph(right - left + 1, bottom - top + 1);
  for (const position of best) {
    result.set(
      (position % source.width) - left,
      Math.trunc(position / source.width) - top,
      true,
    );
  }
  return result;
}

function normalizeGlyph(source, width, height) {
  const result = new BinaryGlyph(width, height);
  if (source.width === 0 || source.height === 0) {
    return result;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceLeft = (x * source.width) / width;
      const sourceRight = ((x + 1) * source.width) / width;
      const sourceTop = (y * source.height) / height;
      const sourceBottom = ((y + 1) * source.height) / height;
      let covered = 0;
      const area =
        (sourceRight - sourceLeft) * (sourceBottom - sourceTop);
      for (
        let sourceY = Math.floor(sourceTop);
        sourceY < Math.ceil(sourceBottom);
        sourceY += 1
      ) {
        for (
          let sourceX = Math.floor(sourceLeft);
          sourceX < Math.ceil(sourceRight);
          sourceX += 1
        ) {
          if (!source.at(sourceX, sourceY)) {
            continue;
          }
          const overlapX = Math.max(
            0,
            Math.min(sourceRight, sourceX + 1) -
              Math.max(sourceLeft, sourceX),
          );
          const overlapY = Math.max(
            0,
            Math.min(sourceBottom, sourceY + 1) -
              Math.max(sourceTop, sourceY),
          );
          covered += overlapX * overlapY;
        }
      }
      result.set(x, y, area > 0 && covered / area >= 0.28);
    }
  }
  return result;
}

function normalizeGlyphPreservingAspect(source, width, height) {
  const result = new BinaryGlyph(width, height);
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return result;
  }
  const scale = Math.min(width / source.width, height / source.height);
  const fittedWidth = Math.min(
    width,
    Math.max(1, Math.round(source.width * scale)),
  );
  const fittedHeight = Math.min(
    height,
    Math.max(1, Math.round(source.height * scale)),
  );
  const fitted = normalizeGlyph(source, fittedWidth, fittedHeight);
  const offsetX = Math.trunc((width - fittedWidth) / 2);
  const offsetY = Math.trunc((height - fittedHeight) / 2);
  for (let y = 0; y < fittedHeight; y += 1) {
    for (let x = 0; x < fittedWidth; x += 1) {
      if (fitted.at(x, y)) {
        result.set(offsetX + x, offsetY + y, true);
      }
    }
  }
  return result;
}

function templateList(map, character) {
  return Array.isArray(map?.[character]) ? map[character] : [];
}

export const __testing = Object.freeze({
  BinaryGlyph,
  alignedGlyphOverlapDistance,
  decodeGlyphTemplates,
  glyphDistance,
  inspectGlyphTopology,
  prepareGlyph,
  selectBestGlyphMatch,
  topologyAgrees,
});
