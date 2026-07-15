const MAX_RUNS = 180;
const MAX_FINDINGS = 12;
const MAX_TEXT_LENGTH = 280;

export function createPdfTextPage(textContent, viewport) {
  const pageWidth = Math.max(1, Number(viewport?.width) || 1);
  const pageHeight = Math.max(1, Number(viewport?.height) || 1);
  const items = (textContent?.items || []).map((item, index) => {
    const text = String(item?.str || "").replaceAll("\u0000", "").trim();
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
      x: clamp(x / pageWidth, 0, 1),
      y: clamp((pageHeight - baseline - rawHeight) / pageHeight, 0, 1),
      width: clamp(rawWidth / pageWidth, 0, 1),
      height: clamp(rawHeight / pageHeight, 0, 1),
    };
  }).filter((item) => item.normalized && item.width > 0 && item.height > 0);
  return { items };
}

export function findPdfTextDifferences(leftPage, rightPage, leftRegion, rightRegion) {
  if (!leftPage?.items?.length || !rightPage?.items?.length) return [];
  const leftItems = leftPage.items.filter((item) => intersectsRegion(item, leftRegion));
  const rightItems = rightPage.items.filter((item) => intersectsRegion(item, rightRegion));
  if (!leftItems.length || !rightItems.length) return [];
  const documentText = {
    reference: leftItems.map((item) => item.normalized).join(""),
    comparison: rightItems.map((item) => item.normalized).join(""),
  };

  const leftRuns = buildTextRuns(leftItems);
  const rightRuns = buildTextRuns(rightItems);
  const candidates = [];
  leftRuns.forEach((left) => {
    rightRuns.forEach((right) => {
      if (left.normalized === right.normalized) return;
      const commonLength = longestCommonSubstringLength(left.normalized, right.normalized);
      const largestLength = Math.max(left.normalized.length, right.normalized.length);
      const score = commonLength / Math.max(1, largestLength);
      if (commonLength < 7 || score < 0.48) return;
      candidates.push({ left, right, score, commonLength });
    });
  });

  const usedLeftItems = new Set();
  const usedRightItems = new Set();
  const seen = new Set();
  const findings = [];
  candidates.sort((first, second) => candidateEditCost(first) - candidateEditCost(second) || second.commonLength - first.commonLength || second.score - first.score);
  for (const candidate of candidates) {
    if (findings.length >= MAX_FINDINGS) break;
    if (candidate.left.itemIds.some((id) => usedLeftItems.has(id))) continue;
    if (candidate.right.itemIds.some((id) => usedRightItems.has(id))) continue;
    const edits = characterEdits(candidate.left.normalized, candidate.right.normalized);
    const differences = editsToFindings(edits, candidate, documentText);
    if (!differences.length) continue;
    candidate.left.itemIds.forEach((id) => usedLeftItems.add(id));
    candidate.right.itemIds.forEach((id) => usedRightItems.add(id));
    for (const finding of differences) {
      const key = `${finding.kind}:${finding.referenceText}:${finding.comparisonText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) break;
    }
  }
  return findings.sort((first, second) => second.confidence - first.confidence);
}

export function buildPdfTextEvidence(findings) {
  if (!findings?.length) return "";
  return findings.slice(0, 10).map((finding) => {
    const reference = finding.referenceText || "(none)";
    const comparison = finding.comparisonText || "(none)";
    return `- Reference: ${reference}; revised: ${comparison}.`;
  }).join("\n");
}

function buildTextRuns(items) {
  const atomic = items
    .filter((item) => isComparableText(item.normalized))
    .map((item) => createRun([createLine([item])], "atomic"));
  const segments = buildRowSegments(items).map((line) => createRun([line], "line"));
  const verticalRuns = buildRowSegments(items).flatMap((line, index, lines) => {
    const runs = [];
    const current = [line];
    for (let nextIndex = index + 1; nextIndex < lines.length && current.length < 3; nextIndex += 1) {
      const next = lines[nextIndex];
      if (!followsLine(current[current.length - 1], next)) continue;
      current.push(next);
      runs.push(createRun([...current], "block"));
    }
    return runs;
  });

  const seen = new Set();
  return [...atomic, ...segments, ...verticalRuns]
    .filter((run) => isComparableText(run.normalized))
    .filter((run) => {
      const key = `${run.itemIds.join(",")}:${run.normalized}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((first, second) => second.normalized.length - first.normalized.length)
    .slice(0, MAX_RUNS);
}

function buildRowSegments(items) {
  const ordered = [...items]
    .filter((item) => isComparableText(item.normalized))
    .sort((first, second) => first.y - second.y || first.x - second.x);
  const rows = [];
  ordered.forEach((item) => {
    const current = rows.at(-1);
    const tolerance = Math.max(0.0025, Math.min(item.height, current?.height || item.height) * 0.6);
    if (!current || Math.abs(current.y - item.y) > tolerance) {
      rows.push({ y: item.y, height: item.height, items: [item] });
      return;
    }
    current.items.push(item);
    current.height = Math.max(current.height, item.height);
  });

  return rows.flatMap((row) => {
    const segments = [];
    let segment = [];
    row.items.sort((first, second) => first.x - second.x).forEach((item) => {
      const previous = segment.at(-1);
      const gap = previous ? item.x - (previous.x + previous.width) : 0;
      const maximumGap = Math.max(0.018, Math.max(item.height, previous?.height || 0) * 1.8);
      if (previous && gap > maximumGap) {
        segments.push(createLine(segment));
        segment = [];
      }
      segment.push(item);
    });
    if (segment.length) segments.push(createLine(segment));
    return segments;
  });
}

function createLine(items) {
  const box = unionBoxes(items);
  return {
    itemIds: items.map((item) => item.id),
    normalized: items.map((item) => item.normalized).join(""),
    box,
    x: box.x,
    y: box.y,
    height: box.height,
  };
}

function createRun(lines) {
  const box = unionBoxes(lines.map((line) => line.box));
  const fragments = [];
  let offset = 0;
  lines.forEach((line) => {
    const start = offset;
    offset += line.normalized.length;
    fragments.push({ start, end: offset, box: line.box });
  });
  return {
    itemIds: [...new Set(lines.flatMap((line) => line.itemIds))],
    normalized: lines.map((line) => line.normalized).join(""),
    box,
    fragments,
  };
}

function followsLine(previous, next) {
  const verticalGap = next.y - (previous.y + previous.height);
  const columnDistance = Math.abs(next.x - previous.x);
  return verticalGap >= -0.002
    && verticalGap <= Math.max(0.024, previous.height * 2.8)
    && columnDistance <= 0.1;
}

function editsToFindings(edits, candidate, documentText) {
  const findings = [];
  for (let index = 0; index < edits.length; index += 1) {
    const current = edits[index];
    if (current.type === "equal") continue;
    const next = edits[index + 1];
    const paired = next && next.type !== "equal" && next.type !== current.type;
    const deleted = current.type === "delete" ? current.value : paired && next.type === "delete" ? next.value : "";
    const inserted = current.type === "insert" ? current.value : paired && next.type === "insert" ? next.value : "";
    if (paired) index += 1;
    if (!isMeaningfulDifference(deleted) && !isMeaningfulDifference(inserted)) continue;
    const kind = deleted && inserted ? "changed" : deleted ? "missing_from_comparison" : "missing_from_reference";
    const rightOffset = current.type === "insert" ? current.rightStart : current.rightStart;
    const comparisonBox = anchorComparisonBox(candidate.right, rightOffset, Boolean(inserted));
    const referenceText = deleted || "";
    const comparisonText = inserted || "";
    if (kind === "missing_from_comparison" && containsComparableValue(documentText.comparison, referenceText)) continue;
    if (kind === "missing_from_reference" && containsComparableValue(documentText.reference, comparisonText)) continue;
    if (kind === "changed" && (
      containsComparableValue(documentText.comparison, referenceText)
      || containsComparableValue(documentText.reference, comparisonText)
    )) continue;
    findings.push({
      kind,
      referenceText,
      comparisonText,
      comparisonBox,
      confidence: candidate.score,
      description: describeDifference(kind, referenceText, comparisonText),
      label: labelDifference(kind, referenceText, comparisonText),
    });
  }
  return findings;
}

function candidateEditCost(candidate) {
  return candidate.left.normalized.length + candidate.right.normalized.length - (candidate.commonLength * 2);
}

function containsComparableValue(documentText, value) {
  const target = comparableText(value);
  return target.length >= 2 && comparableText(documentText).includes(target);
}

function characterEdits(left, right) {
  const source = left.slice(0, MAX_TEXT_LENGTH);
  const target = right.slice(0, MAX_TEXT_LENGTH);
  const rows = source.length + 1;
  const columns = target.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let sourceIndex = source.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let targetIndex = target.length - 1; targetIndex >= 0; targetIndex -= 1) {
      matrix[sourceIndex][targetIndex] = source[sourceIndex] === target[targetIndex]
        ? matrix[sourceIndex + 1][targetIndex + 1] + 1
        : Math.max(matrix[sourceIndex + 1][targetIndex], matrix[sourceIndex][targetIndex + 1]);
    }
  }

  const edits = [];
  let sourceIndex = 0;
  let targetIndex = 0;
  while (sourceIndex < source.length || targetIndex < target.length) {
    if (source[sourceIndex] === target[targetIndex]) {
      pushEdit(edits, "equal", source[sourceIndex], sourceIndex, targetIndex);
      sourceIndex += 1;
      targetIndex += 1;
    } else if (targetIndex >= target.length || (sourceIndex < source.length && matrix[sourceIndex + 1][targetIndex] >= matrix[sourceIndex][targetIndex + 1])) {
      pushEdit(edits, "delete", source[sourceIndex], sourceIndex, targetIndex);
      sourceIndex += 1;
    } else {
      pushEdit(edits, "insert", target[targetIndex], sourceIndex, targetIndex);
      targetIndex += 1;
    }
  }
  return edits;
}

function pushEdit(edits, type, character, leftStart, rightStart) {
  const current = edits.at(-1);
  const continues = current?.type === type && (
    (type === "equal" && current.leftStart + current.value.length === leftStart && current.rightStart + current.value.length === rightStart)
    || (type === "delete" && current.leftStart + current.value.length === leftStart && current.rightStart === rightStart)
    || (type === "insert" && current.leftStart === leftStart && current.rightStart + current.value.length === rightStart)
  );
  if (continues) {
    current.value += character;
    return;
  }
  edits.push({ type, value: character, leftStart, rightStart });
}

function longestCommonSubstringLength(left, right) {
  const source = left.slice(0, MAX_TEXT_LENGTH);
  const target = right.slice(0, MAX_TEXT_LENGTH);
  let previous = new Uint16Array(target.length + 1);
  let longest = 0;
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = new Uint16Array(target.length + 1);
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      if (source[sourceIndex - 1] !== target[targetIndex - 1]) continue;
      current[targetIndex] = previous[targetIndex - 1] + 1;
      longest = Math.max(longest, current[targetIndex]);
    }
    previous = current;
  }
  return longest;
}

function anchorComparisonBox(run, offset, useCharacterWidth) {
  const fragment = run.fragments.find((item) => offset >= item.start && offset <= item.end) || run.fragments.at(-1);
  if (!fragment) return run.box;
  const relativeOffset = clamp((offset - fragment.start) / Math.max(1, fragment.end - fragment.start), 0, 1);
  const characterWidth = Math.max(0.014, Math.min(0.06, fragment.box.width * 0.28));
  const width = useCharacterWidth ? characterWidth : Math.max(characterWidth, fragment.box.width * 0.22);
  const x = clamp(fragment.box.x + (fragment.box.width * relativeOffset) - (useCharacterWidth ? 0 : width * 0.35), 0, 1 - width);
  return { x, y: fragment.box.y, width, height: fragment.box.height };
}

function unionBoxes(items) {
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function intersectsRegion(item, region) {
  const left = Number(region?.x) || 0;
  const top = Number(region?.y) || 0;
  const right = left + (Number(region?.width) || 1);
  const bottom = top + (Number(region?.height) || 1);
  return item.x < right && item.x + item.width > left && item.y < bottom && item.y + item.height > top;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replaceAll("\u0000", "")
    .replace(/[‐‑–—]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function isComparableText(value) {
  return value.length >= 5 && /[\p{L}\p{N}]/u.test(value);
}

function isMeaningfulDifference(value) {
  const trimmed = String(value || "").replace(/[^\p{L}\p{N}]/gu, "");
  return trimmed.length >= 2;
}

function comparableText(value) {
  return String(value || "").replace(/[^\p{L}\p{N}]/gu, "");
}

function describeDifference(kind, referenceText, comparisonText) {
  if (kind === "missing_from_comparison") return `ต้นฉบับมี ${referenceText} แต่ฉบับเปรียบเทียบไม่มี`;
  if (kind === "missing_from_reference") return `ฉบับเปรียบเทียบมี ${comparisonText} แต่ต้นฉบับไม่มี`;
  return `ต้นฉบับเป็น ${referenceText} แต่ฉบับเปรียบเทียบเป็น ${comparisonText}`;
}

function labelDifference(kind, referenceText, comparisonText) {
  if (kind === "missing_from_comparison") return `ไม่พบ ${referenceText}`;
  if (kind === "missing_from_reference") return `เพิ่ม ${comparisonText}`;
  return `${referenceText} -> ${comparisonText}`;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
