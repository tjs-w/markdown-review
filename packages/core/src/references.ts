export interface ParsedCommentFeedback {
  readonly text: string;
  readonly references: readonly number[];
}

export function parseCommentFeedback(feedback: string): ParsedCommentFeedback {
  const source = feedback;
  let text = "";
  const references: number[] = [];
  const seen = new Set<number>();
  let codeFenceLength = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "`") {
      let runLength = 1;
      while (source[index + runLength] === "`") runLength += 1;
      text += source.slice(index, index + runLength);
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (codeFenceLength === runLength) codeFenceLength = 0;
      index += runLength - 1;
      continue;
    }

    if (codeFenceLength > 0) {
      text += character;
      continue;
    }

    if (character === "\\" && source[index + 1] === "#" && /[1-9]/.test(source[index + 2] ?? "")) {
      text += "#";
      index += 1;
      continue;
    }

    if (character === "#" && (index === 0 || !/[\w#\\]/.test(source[index - 1] ?? ""))) {
      let end = index + 1;
      while (/\d/.test(source[end] ?? "")) end += 1;
      const digits = source.slice(index + 1, end);
      const hasValidBoundary = end === source.length || !/\w/.test(source[end] ?? "");
      if (/^[1-9]\d*$/.test(digits) && hasValidBoundary) {
        const serial = Number(digits);
        if (Number.isSafeInteger(serial) && !seen.has(serial)) {
          seen.add(serial);
          references.push(serial);
        }
      }
    }

    text += character;
  }

  return { text, references };
}

export function extractCommentReferences(feedback: string): readonly number[] {
  return parseCommentFeedback(feedback).references;
}
