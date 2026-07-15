const MAX_RUNS = 180;
const MAX_FINDINGS = 12;
const MAX_TEXT_LENGTH = 280;
const TABLE_FIELDS = ["material", "description", "price", "total"];
const TABLE_FIELD_LABELS = {
  material: "รหัสสินค้า",
  description: "รายละเอียดสินค้า",
  quantity: "จำนวน",
  unit: "หน่วย",
  price: "ราคาต่อหน่วย",
  total: "ราคารวม",
};

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

export function hasUsablePdfText(leftPage, rightPage, leftRegion, rightRegion) {
  return hasReliableTextInRegion(leftPage, leftRegion)
    && hasReliableTextInRegion(rightPage, rightRegion);
}

export function findPdfTextDifferences(leftPage, rightPage, leftRegion, rightRegion) {
  if (!leftPage?.items?.length || !rightPage?.items?.length) return [];
  const leftItems = usablePdfTextItems(leftPage, leftRegion);
  const rightItems = usablePdfTextItems(rightPage, rightRegion);
  if (!leftItems.length || !rightItems.length) return [];
  const tableFindings = findLineItemTableDifferences(leftItems, rightItems);
  if (tableFindings.length) return tableFindings;
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

function usablePdfTextItems(page, region) {
  return (page?.items || []).filter((item) => item.reliable && intersectsRegion(item, region));
}

function hasReliableTextInRegion(page, region) {
  const regionItems = (page?.items || []).filter((item) => intersectsRegion(item, region));
  const readableItems = regionItems.filter((item) => item.reliable);
  if (readableItems.length < 6) return false;

  // A PDF can expose numbers and Latin fragments while its Thai text is mojibake.
  // In that case, use image comparison rather than making a partial text layer authoritative.
  const meaningfulItems = regionItems.filter((item) => hasMeaningfulText(item.text));
  const readableMeaningful = readableItems.filter((item) => hasMeaningfulText(item.text));
  return !meaningfulItems.length || readableMeaningful.length / meaningfulItems.length >= 0.72;
}

function findLineItemTableDifferences(leftItems, rightItems) {
  const referenceTable = parseLineItemTable(leftItems);
  const comparisonTable = parseLineItemTable(rightItems);
  if (!referenceTable || !comparisonTable) return [];

  const comparisonRows = new Map(comparisonTable.rows.map((row) => [row.id, row]));
  const matchedRows = referenceTable.rows
    .map((referenceRow) => ({ referenceRow, comparisonRow: comparisonRows.get(referenceRow.id) }))
    .filter((pair) => pair.comparisonRow);
  if (matchedRows.length < 2) return [];

  const findings = [];
  matchedRows.forEach(({ referenceRow, comparisonRow }) => {
    TABLE_FIELDS.forEach((field) => {
      const reference = referenceRow.fields[field];
      const comparison = comparisonRow.fields[field];
      if (!reference?.text || !comparison?.text || tableFieldValuesMatch(field, reference.text, comparison.text)) return;
      findings.push({
        kind: "changed",
        referenceText: reference.text,
        comparisonText: comparison.text,
        comparisonBox: comparison.box,
        confidence: 0.96,
        description: describeTableFieldDifference(referenceRow.id, field, reference.text, comparison.text),
        label: `รายการ ${referenceRow.id}: ${TABLE_FIELD_LABELS[field]}`,
      });
    });
  });
  return findings;
}

function parseLineItemTable(items) {
  const header = findLineItemHeader(items);
  if (!header) return null;
  const anchors = findLineItemAnchors(items, header);
  if (anchors.length < 2) return null;
  const rows = anchors.map((anchor, index) => buildLineItemRow(
    items,
    header,
    anchor,
    anchors[index + 1],
  )).filter((row) => Object.values(row.fields).some((field) => field?.text));
  return rows.length >= 2 ? { rows } : null;
}

function findLineItemHeader(items) {
  const rows = groupTextRows(items);
  let best = null;
  rows.forEach((row) => {
    const columns = {};
    row.items.forEach((item) => {
      const field = tableHeaderField(item.text);
      if (!field || columns[field]) return;
      columns[field] = { x: item.x, width: item.width };
    });
    if (!columns.item) return;
    const fields = Object.keys(columns);
    const hasBusinessColumns = Boolean(columns.material || columns.description);
    const hasValueColumns = Boolean(columns.price || columns.total || columns.quantity);
    if (fields.length < 4 || !hasBusinessColumns || !hasValueColumns) return;
    const score = fields.length + (columns.description ? 2 : 0) + (columns.price ? 1 : 0) + (columns.total ? 1 : 0);
    if (!best || score > best.score) best = { y: row.y, height: row.height, columns, score };
  });
  if (!best) return null;

  const anchors = Object.entries(best.columns)
    .map(([field, value]) => ({ field, x: value.x }))
    .sort((first, second) => first.x - second.x);
  const columns = {};
  anchors.forEach((anchor, index) => {
    columns[anchor.field] = {
      start: Math.max(0, anchor.x - 0.012),
      end: index < anchors.length - 1 ? Math.max(anchor.x + 0.012, anchors[index + 1].x - 0.006) : 1,
    };
  });
  return { y: best.y, height: best.height, columns };
}

function tableHeaderField(value) {
  const text = normalizeText(value).replace(/[^\p{L}\p{N}]/gu, "");
  if (text.includes("ITEM")) return "item";
  if (text.includes("MATERIAL") || text === "PRODUCT" || text.includes("PRODUCTCODE")) return "material";
  if (text.includes("DESCRIPTION") || text.includes("DETAIL")) return "description";
  if (text.includes("QUANTITY") || text === "QTY") return "quantity";
  if (text.includes("UNIT")) return "unit";
  if (text.includes("PRICE") || text.includes("UNITPRICE")) return "price";
  if (text.includes("SUBTOTAL") || text === "TOTAL" || text.includes("AMOUNT")) return "total";
  return null;
}

function findLineItemAnchors(items, header) {
  const candidateRows = groupTextRows(items.filter((item) => item.y > header.y + Math.max(header.height * 0.5, 0.004)));
  const candidates = candidateRows.map((row) => {
    const item = row.items.find((entry) => itemIsInColumn(entry, header.columns.item) && isLineItemNumber(entry.text));
    return item ? { id: Number(item.text.trim()), y: row.y } : null;
  }).filter(Boolean);

  const anchors = [];
  let expected = 1;
  for (const candidate of candidates) {
    if (candidate.id < expected) continue;
    if (candidate.id !== expected) {
      if (anchors.length) break;
      continue;
    }
    anchors.push(candidate);
    expected += 1;
  }
  return anchors;
}

function buildLineItemRow(items, header, anchor, nextAnchor) {
  const bottom = nextAnchor
    ? nextAnchor.y - 0.002
    : anchor.y + Math.max(0.042, header.height * 4.2);
  const rowItems = items.filter((item) => item.y >= anchor.y - 0.003 && item.y < bottom);
  const fields = {};
  const materialItem = findMaterialItem(rowItems, header, anchor);
  if (materialItem) fields.material = fieldFromItems([materialItem]);

  const descriptionItems = findDescriptionItems(rowItems, header, materialItem);
  if (descriptionItems.length) {
    fields.description = fieldFromItems(descriptionItems, true);
  }

  ["price", "total"].forEach((field) => {
    const column = header.columns[field];
    if (!column) return;
    const fieldItems = rowItems
      .filter((item) => itemIsInColumn(item, column))
      .sort((first, second) => first.y - second.y || first.x - second.x);
    if (!fieldItems.length) return;
    fields[field] = fieldFromItems(fieldItems);
  });
  return { id: anchor.id, fields };
}

function findMaterialItem(items, header, anchor) {
  const contentEnd = Math.min(
    header.columns.quantity?.start ?? 1,
    header.columns.price?.start ?? 1,
    header.columns.total?.start ?? 1,
  );
  return items
    .filter((item) => item.y <= anchor.y + Math.max(0.016, header.height * 1.8))
    .filter((item) => !itemIsInColumn(item, header.columns.item))
    .filter((item) => item.x < contentEnd)
    .filter((item) => isMaterialCode(item.text))
    .sort((first, second) => first.x - second.x || first.y - second.y)[0] || null;
}

function findDescriptionItems(items, header, materialItem) {
  if (!materialItem) return [];
  const contentEnd = Math.min(
    header.columns.quantity?.start ?? 1,
    header.columns.price?.start ?? 1,
    header.columns.total?.start ?? 1,
  );
  const materialEnd = materialItem.x + materialItem.width;
  return items
    .filter((item) => item !== materialItem)
    .filter((item) => item.x + item.width * 0.3 >= materialEnd - 0.003)
    .filter((item) => item.x < contentEnd)
    .filter((item) => !itemIsInColumn(item, header.columns.item))
    .filter((item) => !isStandaloneCounter(item.text))
    .sort((first, second) => first.y - second.y || first.x - second.x);
}

function fieldFromItems(items, isDescription = false) {
  const rawText = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  return {
    text: isDescription ? cleanDescriptionText(rawText) : rawText,
    box: unionBoxes(items),
  };
}

function isMaterialCode(value) {
  const text = normalizeText(value);
  if (text.length < 5 || !/\d/.test(text)) return false;
  if (/^\d{1,3}(?:[,.]\d{3})*(?:\.\d{2})?$/.test(text)) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}#&/._-]*$/u.test(text);
}

function isStandaloneCounter(value) {
  return /^\(?\d{1,3}\)?$/.test(String(value || "").trim());
}

function cleanDescriptionText(value) {
  return String(value || "")
    .replace(/\([^)]{0,64}\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupTextRows(items) {
  const rows = [];
  [...items]
    .sort((first, second) => first.y - second.y || first.x - second.x)
    .forEach((item) => {
      const current = rows.at(-1);
      const tolerance = Math.max(0.011, Math.max(item.height, current?.height || 0) * 0.8);
      if (!current || Math.abs(item.y - current.y) > tolerance) {
        rows.push({ y: item.y, height: item.height, items: [item] });
        return;
      }
      current.items.push(item);
      current.height = Math.max(current.height, item.height);
    });
  return rows;
}

function itemIsInColumn(item, column) {
  if (!column) return false;
  const center = item.x + (item.width / 2);
  return center >= column.start && center < column.end;
}

function isLineItemNumber(value) {
  const number = String(value || "").trim();
  return /^\d{1,3}$/.test(number) && Number(number) > 0;
}

function tableFieldValuesMatch(field, referenceText, comparisonText) {
  const reference = comparableText(referenceText);
  const comparison = comparableText(comparisonText);
  if (reference === comparison) return true;
  if (field !== "description") return false;
  const shorter = reference.length <= comparison.length ? reference : comparison;
  const longer = reference.length > comparison.length ? reference : comparison;
  return shorter.length >= 10 && longer.includes(shorter);
}

function describeTableFieldDifference(itemNumber, field, referenceText, comparisonText) {
  const prefix = `รายการ ${itemNumber}: `;
  if (field === "description") return prefix + describeDescriptionDifference(referenceText, comparisonText);
  const label = TABLE_FIELD_LABELS[field] || "ข้อมูล";
  return `${prefix}${label}เปลี่ยนจาก ${shortValue(referenceText)} เป็น ${shortValue(comparisonText)}`;
}

function describeDescriptionDifference(referenceText, comparisonText) {
  const edits = characterEdits(normalizeText(referenceText), normalizeText(comparisonText));
  const deleted = selectUsefulEditFragment(edits, "delete");
  const inserted = selectUsefulEditFragment(edits, "insert");
  if (deleted && (!inserted || deleted.score <= inserted.score)) {
    return `รายละเอียดสินค้า: ต้นฉบับมี ${deleted.value} แต่ฉบับเปรียบเทียบไม่มี`;
  }
  if (inserted) return `รายละเอียดสินค้า: ฉบับเปรียบเทียบมี ${inserted.value} แต่ต้นฉบับไม่มี`;
  return `รายละเอียดสินค้าเปลี่ยนจาก ${shortValue(referenceText)} เป็น ${shortValue(comparisonText)}`;
}

function selectUsefulEditFragment(edits, type) {
  const candidates = edits
    .filter((edit) => edit.type === type && isMeaningfulDifference(edit.value))
    .filter((edit) => comparableText(edit.value).length >= 3)
    .map((edit) => ({
      value: edit.value,
      score: edit.value.length
        - (/\d/.test(edit.value) ? 14 : 0)
        - (/[\/#&,_-]/.test(edit.value) ? 8 : 0)
        + (/^[\p{Script=Thai}]+$/u.test(edit.value) ? 12 : 0),
    }))
    .filter((edit) => edit.value.length <= 72)
    .sort((first, second) => first.score - second.score || first.value.length - second.value.length);
  return candidates[0] || null;
}

function shortValue(value, maximum = 68) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 3)}...`;
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
  return cleanPdfText(value)
    .normalize("NFKC")
    .replace(/[‐‑–—]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
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
