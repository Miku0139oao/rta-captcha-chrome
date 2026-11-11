// Geometry, normalisation and topology primitives shared by the runtime solver
// and the build-time template generator. This module must not import the
// generated template data: scripts/generate-template-data.mjs imports it to
// annotate templates, and a cycle back into templates.generated.js would make
// the generator read stale data.

export const TEMPLATE_WIDTH = 15;
export const TEMPLATE_HEIGHT = 21;

export class BinaryGlyph {
  constructor(width, height, pixels = undefined) {
    this.width = width;
    this.height = height;
    this.pixels = pixels ?? new Uint8Array(width * height);
  }

  at(x, y) {
    return (
      x >= 0 &&
      x < this.width &&
      y >= 0 &&
      y < this.height &&
      this.pixels[y * this.width + x] !== 0
    );
  }

  set(x, y, value) {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
      this.pixels[y * this.width + x] = value ? 1 : 0;
    }
  }

  foregroundCount() {
    let count = 0;
    for (const foreground of this.pixels) {
      count += foreground !== 0 ? 1 : 0;
    }
    return count;
  }
}

export function decodeGlyphTemplates(encodedTemplates = []) {
  return encodedTemplates.map(decodeGlyphTemplate);
}

export function decodeGlyphTemplate(encoded) {
  const packed = base64ToBytes(encoded);
  const glyph = new BinaryGlyph(TEMPLATE_WIDTH, TEMPLATE_HEIGHT);
  const pixels = glyph.pixels;
  const limit = Math.min(packed.length * 8, pixels.length);
  for (let position = 0; position < limit; position += 1) {
    pixels[position] = (packed[position >> 3] >> (position & 7)) & 1;
  }
  return glyph;
}

function base64ToBytes(encoded) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Topology is a pure function of the glyph bitmap, so the template generator
// precomputes it and passes the result in. Without that hint this walk (noise
// bridge breaking plus two flood fills per template) dominates cold start.
export function prepareGlyphTemplates(glyphs, topologies = undefined) {
  return glyphs.map((glyph, index) =>
    prepareGlyph(glyph, topologies?.[index]),
  );
}

export function prepareGlyph(glyph, topology = undefined) {
  const foreground = [];
  const rows = glyph.width <= 32 ? new Uint32Array(glyph.height) : null;
  for (let position = 0; position < glyph.pixels.length; position += 1) {
    if (glyph.pixels[position] === 0) {
      continue;
    }
    foreground.push(position);
    if (rows) {
      rows[Math.trunc(position / glyph.width)] |= 1 << (position % glyph.width);
    }
  }
  return {
    glyph,
    foreground: Uint16Array.from(foreground),
    rows,
    topology: topology ?? inspectGlyphTopology(glyph),
  };
}

export function glyphDistance(left, right) {
  if (
    left.glyph.width !== right.glyph.width ||
    left.glyph.height !== right.glyph.height
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const leftCount = left.foreground.length;
  const rightCount = right.foreground.length;
  if (leftCount === 0 || rightCount === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const densityPenalty =
    Math.abs(leftCount - rightCount) / Math.max(leftCount, rightCount);
  const holePenalty =
    Math.abs(left.topology.holes - right.topology.holes) * 0.06;
  let openingPenalty = 0;
  if (left.topology.rightOpening !== right.topology.rightOpening) {
    openingPenalty += 0.045;
  }
  if (left.topology.leftOpening !== right.topology.leftOpening) {
    openingPenalty += 0.03;
  }
  return (
    alignedGlyphOverlapDistance(left, right) +
    densityPenalty * 0.05 +
    holePenalty +
    openingPenalty
  );
}

export function alignedGlyphOverlapDistance(left, right) {
  let best = 1;
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      let intersection = 0;
      if (left.rows && right.rows) {
        for (let leftY = 0; leftY < left.rows.length; leftY += 1) {
          const rightY = leftY + offsetY;
          if (rightY < 0 || rightY >= right.rows.length) {
            continue;
          }
          let row = left.rows[leftY];
          row = offsetX < 0 ? row >>> -offsetX : (row << offsetX) >>> 0;
          intersection += popcount32((row & right.rows[rightY]) >>> 0);
        }
      } else {
        for (const position of left.foreground) {
          const x = (position % left.glyph.width) + offsetX;
          const y = Math.trunc(position / left.glyph.width) + offsetY;
          if (right.glyph.at(x, y)) {
            intersection += 1;
          }
        }
      }
      const distance =
        1 -
        (2 * intersection) /
          (left.foreground.length + right.foreground.length);
      best = Math.min(best, distance);
    }
  }
  return best;
}

export function popcount32(value) {
  let result = value - ((value >>> 1) & 0x55555555);
  result = (result & 0x33333333) + ((result >>> 2) & 0x33333333);
  return (((result + (result >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function inspectGlyphTopology(glyph) {
  const cleaned = breakNoiseBridges(glyph);
  return {
    holes: countGlyphHoles(cleaned),
    rightOpening: sideOpening(cleaned, 1),
    leftOpening: sideOpening(cleaned, -1),
  };
}

export function breakNoiseBridges(source) {
  if (source.width < 4 || source.height < 6) {
    return source;
  }
  const eroded = new BinaryGlyph(source.width, source.height);
  for (let y = 1; y < source.height - 1; y += 1) {
    for (let x = 1; x < source.width - 1; x += 1) {
      if (!source.at(x, y)) {
        continue;
      }
      let neighbors = 0;
      neighbors += source.at(x - 1, y) ? 1 : 0;
      neighbors += source.at(x + 1, y) ? 1 : 0;
      neighbors += source.at(x, y - 1) ? 1 : 0;
      neighbors += source.at(x, y + 1) ? 1 : 0;
      if (neighbors >= 2) {
        eroded.set(x, y, true);
      }
    }
  }

  const result = new BinaryGlyph(source.width, source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (!eroded.at(x, y)) {
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
  return result.foregroundCount() < 12 ? source : result;
}

export function sideOpening(glyph, direction) {
  if (glyph.width < 4 || glyph.height < 6) {
    return false;
  }
  const top = Math.trunc((glyph.height * 3) / 10);
  const bottom = Math.trunc((glyph.height * 7) / 10);
  if (bottom <= top) {
    return false;
  }
  let openRows = 0;
  let inkRows = 0;
  for (let y = top; y < bottom; y += 1) {
    let hasInk = false;
    for (let x = 0; x < glyph.width; x += 1) {
      if (glyph.at(x, y)) {
        hasInk = true;
        break;
      }
    }
    if (!hasInk) {
      continue;
    }
    inkRows += 1;
    if (direction > 0) {
      let edge = glyph.width - 1;
      while (edge >= 0 && !glyph.at(edge, y)) {
        edge -= 1;
      }
      if (edge < Math.trunc((glyph.width * 3) / 4)) {
        openRows += 1;
      }
    } else {
      let edge = 0;
      while (edge < glyph.width && !glyph.at(edge, y)) {
        edge += 1;
      }
      if (edge > Math.trunc(glyph.width / 4)) {
        openRows += 1;
      }
    }
  }
  return inkRows > 0 && openRows / inkRows >= 0.45;
}

export function topologyAgrees(character, topology) {
  switch (character) {
    case "0":
      return topology.holes >= 1 && !topology.rightOpening;
    case "8":
      return topology.holes >= 2;
    case "6":
    case "9":
    case "a":
    case "b":
    case "d":
      return topology.holes >= 1;
    case "c":
    case "e":
      return topology.rightOpening || topology.holes === 0;
    case "3":
      return topology.leftOpening || topology.holes === 0;
    default:
      return true;
  }
}

export function countGlyphHoles(glyph) {
  const visited = new Uint8Array(glyph.pixels.length);
  let holes = 0;
  for (let start = 0; start < glyph.pixels.length; start += 1) {
    if (glyph.pixels[start] !== 0 || visited[start] !== 0) {
      continue;
    }
    const queue = [start];
    visited[start] = 1;
    let touchesEdge = false;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const position = queue[cursor];
      const x = position % glyph.width;
      const y = Math.trunc(position / glyph.width);
      if (
        x === 0 ||
        x === glyph.width - 1 ||
        y === 0 ||
        y === glyph.height - 1
      ) {
        touchesEdge = true;
      }
      for (const [stepX, stepY] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nextX = x + stepX;
        const nextY = y + stepY;
        if (
          nextX < 0 ||
          nextX >= glyph.width ||
          nextY < 0 ||
          nextY >= glyph.height
        ) {
          continue;
        }
        const next = nextY * glyph.width + nextX;
        if (glyph.pixels[next] === 0 && visited[next] === 0) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    if (!touchesEdge) {
      holes += 1;
    }
  }
  return holes;
}

// Topology hints travel with the generated templates as three flag characters
// ("holes", "rightOpening", "leftOpening") so the runtime never has to walk the
// bitmap to recover them.
export function encodeGlyphTopology(topology) {
  return `${topology.holes}${topology.rightOpening ? 1 : 0}${topology.leftOpening ? 1 : 0}`;
}

export function decodeGlyphTopology(encoded) {
  return {
    holes: Number(encoded[0] ?? 0),
    rightOpening: encoded[1] === "1",
    leftOpening: encoded[2] === "1",
  };
}
