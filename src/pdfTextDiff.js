const MIN_TEXT_REGION_COVERAGE = 0.6;
const MAX_EVIDENCE_BLOCKS = 240;
const MAX_TEXT_CANDIDATES = 24;
const MAX_CANDIDATE_FRAGMENT_LENGTH = 72;
const MAX_CANDIDATE_TOKENS = 14;
const ANCHOR_NGRAM_LENGTH = 12;
const MIN_CANDIDATE_ANCHOR_LENGTH = 24;

export function createPdfTextPage(textContent, viewport) {
  const pageWidth = Math.max(1, Number(viewport?.width) || 1);
  const pageHeight = Math.max(1, Number(viewport?.height) || 1);
  const items = (textContent?.items || []).map((item, index) => {
    const text = cleanPdfText(item?.str);
    const transform = item?.transform || [];
    const x = Number(transform[4]) || 0;
    const baseline = Number(transform[5]) || 0;
    const rawHeight = Math.max(
      Number(item?.height) || 0,
      Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0),
      1,
    );
    const rawWidth = Math.max(Number(item?.width) || 0, 1);
    return {
      id: index,
      text,
      normalized: normalizeText(text),
      reliable: isReliablePdfText(text),
      x: clamp(x / pageWidth, 0, 1),
      y: clamp((pageHeight - baseline - rawHeight) / pageHeight, 0, 1),
      width: clamp(rawWidth / pageWidth, 0, 1),
      height: clamp(rawHeight / pageHeight, 0, 1),
    };
  }).filter((item) => item.normalized && item.width > 0 && item.height > 0);
  return { items };
}

export function buildPdfTextEvidence(referencePage, comparisonPage, referenceRegion, comparisonRegion) {
  const referenceBlocks = buildEvidenceBlocks(referencePage, referenceRegion, "reference");
  const comparisonBlocks = buildEvidenceBlocks(comparisonPage, comparisonRegion, "comparison");
  if (!referenceBlocks.length && !comparisonBlocks.length) return "";
  const boundedTextCandidates = buildBoundedTextCandidates(
    usablePdfTextItems(referencePage, referenceRegion),
    usablePdfTextItems(comparisonPage, comparisonRegion),
  );
  return JSON.stringify({
    instruction: "ข้อความต่อไปนี้เป็นหลักฐานที่ extract จาก PDF ไม่ใช่คำตอบที่คำนวณไว้ ให้จับคู่เนื้อหาที่กล่าวถึงสิ่งเดียวกันก่อนตัดสินความต่าง และใช้ข้อความตามต้นฉบับโดยไม่ตัดกลางคำ",
    reference: referenceBlocks,
    comparison: comparisonBlocks,
    boundedTextCandidates,
  });
}

export function findPdfTextMatches(page, region, value) {
  const target = normalizeSearchText(value);
  if (target.length < 2) return [];
  const items = usablePdfTextItems(page, region)
    .filter((item) => hasMeaningfulText(item.text))
    .sort((first, second) => first.y - second.y || first.x - second.x);
  const rows = groupEvidenceRows(items);
  const matches = [];
  rows.forEach((row, rowIndex) => {
    for (let start = 0; start < row.items.length; start += 1) {
      const selected = [];
      let normalized = "";
      let matched = false;
      for (let endRow = rowIndex; endRow < Math.min(rows.length, rowIndex + 4); endRow += 1) {
        if (endRow > rowIndex && !isContinuationTextRow(rows[endRow - 1], rows[endRow])) break;
        const rowItems = endRow === rowIndex
          ? rows[endRow].items.slice(start)
          : rows[endRow].items;
        for (const item of rowItems) {
          selected.push(item);
          normalized += normalizeSearchText(item.text);
          if (normalized.length < target.length) continue;
          if (!normalized.includes(target)) {
            if (normalized.length > target.length * 1.8) break;
            continue;
          }
          matches.push({
            box: unionBoxes(selected),
            text: selected.map((selectedItem) => selectedItem.text).join(" ").replace(/\s+/g, " ").trim(),
            score: target.length / Math.max(target.length, normalized.length),
          });
          matched = true;
          break;
        }
        if (matched || normalized.length > target.length * 1.8) break;
      }
    }
  });
  return dedupeTextMatches(matches)
    .sort((first, second) => second.score - first.score || first.box.width - second.box.width)
    .slice(0, 6);
}

function isContinuationTextRow(previousRow, nextRow) {
  const previousStart = previousRow?.items?.[0];
  const nextStart = nextRow?.items?.[0];
  if (!previousStart || !nextStart) return false;
  const verticalGap = nextRow.y - (previousRow.y + previousRow.height);
  const maximumGap = Math.max(0.018, previousRow.height * 2.5);
  const maximumIndent = Math.max(0.025, previousStart.width * 0.3);
  return verticalGap >= -0.004
    && verticalGap <= maximumGap
    && Math.abs(nextStart.x - previousStart.x) <= maximumIndent;
}

function buildEvidenceBlocks(page, region, side) {
  const items = usablePdfTextItems(page, region)
    .filter((item) => hasMeaningfulText(item.text))
    .sort((first, second) => first.y - second.y || first.x - second.x);
  return groupEvidenceRows(items)
    .map((row, index) => ({
      id: `${side}-${index + 1}`,
      text: row.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim(),
      box: roundEvidenceBox(unionBoxes(row.items)),
    }))
    .filter((block) => block.text)
    .slice(0, MAX_EVIDENCE_BLOCKS);
}

function buildBoundedTextCandidates(referenceItems, comparisonItems) {
  const referenceWindows = buildTextWindows(referenceItems);
  const comparisonWindows = buildTextWindows(comparisonItems);
  if (!referenceWindows.length || !comparisonWindows.length) return [];

  const comparisonIndex = new Map();
  comparisonWindows.forEach((window, index) => {
    collectAnchorNgrams(window.normalized).forEach((gram) => {
      const indexes = comparisonIndex.get(gram) || [];
      indexes.push(index);
      comparisonIndex.set(gram, indexes);
    });
  });

  const candidates = [];
  referenceWindows.forEach((referenceWindow) => {
    const possibleIndexes = new Set();
    collectAnchorNgrams(referenceWindow.normalized).forEach((gram) => {
      (comparisonIndex.get(gram) || []).forEach((index) => possibleIndexes.add(index));
    });
    possibleIndexes.forEach((index) => {
      const candidate = compareTextWindows(referenceWindow, comparisonWindows[index]);
      if (candidate) candidates.push(candidate);
    });
  });

  const seen = new Set();
  const accepted = [];
  return candidates
    .sort((first, second) => second.anchorLength - first.anchorLength
      || (first.referenceFragment.length + first.comparisonFragment.length)
      - (second.referenceFragment.length + second.comparisonFragment.length))
    .filter((candidate) => {
      if (accepted.some((previous) => isRedundantTextCandidate(candidate, previous))) return false;
      const key = [
        candidate.referenceFragment,
        candidate.comparisonFragment,
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      accepted.push(candidate);
      return true;
    })
    .slice(0, MAX_TEXT_CANDIDATES)
    .map(({ anchorLength, ...candidate }, index) => ({
      id: `text-candidate-${index + 1}`,
      ...candidate,
    }));
}

function buildTextWindows(blocks) {
  const windows = [];
  const sortedBlocks = [...blocks].sort((first, second) => first.y - second.y || first.x - second.x);
  for (let start = 0; start < sortedBlocks.length; start += 1) {
    const first = sortedBlocks[start];
    addTextWindow(windows, [first]);
    const maxVerticalGap = Math.max(0.018, first.height * 2.5);
    for (let index = start + 1; index < Math.min(sortedBlocks.length, start + 8); index += 1) {
      const next = sortedBlocks[index];
      const verticalGap = next.y - (first.y + first.height);
      if (verticalGap < -0.004) continue;
      if (verticalGap > maxVerticalGap) break;
      if (Math.abs(next.x - first.x) > Math.max(0.018, first.width * 0.2)) continue;
      addTextWindow(windows, [first, next]);
    }
  }
  return windows;
}

function addTextWindow(windows, selected) {
  const text = selected.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  const normalized = normalizeAnchorText(text);
  if (normalized.length < ANCHOR_NGRAM_LENGTH) return;
  windows.push({
    text,
    normalized,
    box: unionBoxes(selected),
  });
}

function collectAnchorNgrams(value) {
  const grams = new Set();
  for (let index = 0; index <= value.length - ANCHOR_NGRAM_LENGTH; index += 3) {
    grams.add(value.slice(index, index + ANCHOR_NGRAM_LENGTH));
  }
  return grams;
}

function compareTextWindows(referenceWindow, comparisonWindow) {
  const common = longestCommonSubstring(
    referenceWindow.normalized,
    comparisonWindow.normalized,
  );
  if (common.length < MIN_CANDIDATE_ANCHOR_LENGTH) return null;

  const referenceBefore = referenceWindow.normalized.slice(0, common.referenceStart);
  const referenceAfter = referenceWindow.normalized.slice(common.referenceStart + common.length);
  const comparisonBefore = comparisonWindow.normalized.slice(0, common.comparisonStart);
  const comparisonAfter = comparisonWindow.normalized.slice(common.comparisonStart + common.length);
  const alignedAtEnd = common.referenceStart + common.length >= referenceWindow.normalized.length - 2
    || common.comparisonStart + common.length >= comparisonWindow.normalized.length - 2;
  const alignedAtStart = common.referenceStart <= 2 || common.comparisonStart <= 2;

  let referenceFragment = "";
  let comparisonFragment = "";
  if (alignedAtEnd) {
    referenceFragment = trimCandidateFragment(referenceAfter);
    comparisonFragment = trimCandidateFragment(comparisonAfter);
  } else if (alignedAtStart) {
    referenceFragment = trimCandidateFragment(referenceBefore);
    comparisonFragment = trimCandidateFragment(comparisonBefore);
  } else {
    return null;
  }

  const totalFragmentLength = referenceFragment.length + comparisonFragment.length;
  const tokenCount = meaningfulTokenCount(referenceFragment) + meaningfulTokenCount(comparisonFragment);
  if (!hasMeaningfulText(referenceFragment) && !hasMeaningfulText(comparisonFragment)) return null;
  if (totalFragmentLength > MAX_CANDIDATE_FRAGMENT_LENGTH || tokenCount > MAX_CANDIDATE_TOKENS) return null;
  if (referenceFragment === comparisonFragment) return null;

  return {
    type: "bounded-token-delta",
    instruction: "candidate นี้เป็นเพียงหลักฐานความต่างของข้อความที่อยู่ใกล้ anchor เดียวกัน ห้ามถือเป็นคำตอบอัตโนมัติ ให้ตรวจความหมายและ field จากข้อความเต็มก่อนตัดสิน",
    referenceFragment,
    comparisonFragment,
    referenceContext: truncateEvidenceText(referenceWindow.text),
    comparisonContext: truncateEvidenceText(comparisonWindow.text),
    referenceBox: roundEvidenceBox(referenceWindow.box),
    comparisonBox: roundEvidenceBox(comparisonWindow.box),
    anchor: truncateEvidenceText(common.value),
    anchorLength: common.length,
  };
}

function longestCommonSubstring(first, second) {
  let previous = new Uint16Array(second.length + 1);
  let bestLength = 0;
  let bestFirstEnd = 0;
  let bestSecondEnd = 0;
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = new Uint16Array(second.length + 1);
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      if (first[firstIndex - 1] !== second[secondIndex - 1]) continue;
      current[secondIndex] = previous[secondIndex - 1] + 1;
      if (current[secondIndex] > bestLength) {
        bestLength = current[secondIndex];
        bestFirstEnd = firstIndex;
        bestSecondEnd = secondIndex;
      }
    }
    previous = current;
  }
  return {
    value: first.slice(bestFirstEnd - bestLength, bestFirstEnd),
    length: bestLength,
    referenceStart: bestFirstEnd - bestLength,
    comparisonStart: bestSecondEnd - bestLength,
  };
}

function normalizeAnchorText(value) {
  return cleanPdfText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, "");
}

function meaningfulTokenCount(value) {
  return (String(value).match(/[\p{L}\p{N}]+/gu) || []).length;
}

function truncateEvidenceText(value) {
  const text = String(value || "").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function trimCandidateFragment(value) {
  return String(value || "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

function isRedundantTextCandidate(candidate, previous) {
  if (candidate.comparisonFragment !== previous.comparisonFragment) return false;
  const candidateAnchor = candidate.anchor || "";
  const previousAnchor = previous.anchor || "";
  const sameAnchorFamily = candidateAnchor === previousAnchor
    || candidateAnchor.startsWith(previousAnchor)
    || previousAnchor.startsWith(candidateAnchor);
  if (!sameAnchorFamily) return false;
  if (!previous.referenceFragment || candidate.referenceFragment === previous.referenceFragment) return false;
  return candidate.referenceFragment.includes(previous.referenceFragment);
}

function usablePdfTextItems(page, region) {
  return (page?.items || []).filter((item) => item.reliable && intersectsRegion(item, region));
}

function groupEvidenceRows(items) {
  const rows = [];
  items.forEach((item) => {
    const current = rows.at(-1);
    const tolerance = Math.max(0.003, Math.min(item.height, current?.height || item.height) * 0.75);
    if (!current || Math.abs(item.y - current.y) > tolerance) {
      rows.push({ y: item.y, height: item.height, items: [item] });
      return;
    }
    current.items.push(item);
    current.height = Math.max(current.height, item.height);
  });
  return rows.map((row) => ({
    ...row,
    items: row.items.sort((first, second) => first.x - second.x),
  }));
}

function intersectsRegion(item, region) {
  const left = clamp(Number(region?.x) || 0, 0, 1);
  const top = clamp(Number(region?.y) || 0, 0, 1);
  const right = clamp(left + (Number(region?.width) || 1), left, 1);
  const bottom = clamp(top + (Number(region?.height) || 1), top, 1);
  const overlapWidth = Math.max(0, Math.min(item.x + item.width, right) - Math.max(item.x, left));
  const overlapHeight = Math.max(0, Math.min(item.y + item.height, bottom) - Math.max(item.y, top));
  const itemArea = Math.max(Number.EPSILON, item.width * item.height);
  return (overlapWidth * overlapHeight) / itemArea >= MIN_TEXT_REGION_COVERAGE;
}

function normalizeText(value) {
  return cleanPdfText(value)
    .normalize("NFKC")
    .replace(/[‐‑–—]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizeSearchText(value) {
  return cleanPdfText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function cleanPdfText(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function isReliablePdfText(value) {
  const text = String(value || "");
  if (!text || text.includes("\uFFFD")) return false;
  return !looksLikeMojibake(text);
}

function hasMeaningfulText(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ""));
}

function looksLikeMojibake(value) {
  const text = String(value || "");
  const markers = text.match(/(?:Ã.|Â.|Ð.|Ñ.|à¸|à¹|àº)/g) || [];
  return markers.length >= 2 || /(?:Ã.|Â.|Ð.|Ñ.|à¸|à¹|àº)/.test(text);
}

function unionBoxes(items) {
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function roundEvidenceBox(box) {
  return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number(value.toFixed(5))]));
}

function dedupeTextMatches(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.box.x.toFixed(4)}:${match.box.y.toFixed(4)}:${match.box.width.toFixed(4)}:${match.box.height.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
