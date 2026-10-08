/** Maps key presses to labeler actions; kept free of DOM types so it is unit-testable. */

export interface KeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export type ItemAction =
  | { kind: "toggleClass"; name: string }
  | { kind: "confirm" }
  | { kind: "skip" }
  | { kind: "delete" }
  | { kind: "reapplyLast" }
  | { kind: "previous" }
  | { kind: "next" }
  | { kind: "close" };

function hasCommandModifier(press: KeyPress): boolean {
  return Boolean(press.ctrlKey || press.metaKey || press.altKey);
}

/** Classes are numbered across all groups in order; only the first nine have a digit. */
export function classForDigit(key: string, classNames: string[]): string | undefined {
  if (key.length !== 1 || key < "1" || key > "9") {
    return undefined;
  }
  return classNames[Number(key) - 1];
}

function shiftedAction(letter: string): ItemAction | undefined {
  if (letter === "C") {
    return { kind: "reapplyLast" };
  }
  if (letter === "D") {
    return { kind: "delete" };
  }
  if (letter === "S") {
    return { kind: "skip" };
  }
  return undefined;
}

function navigationAction(key: string): ItemAction | undefined {
  if (key === "ArrowLeft") {
    return { kind: "previous" };
  }
  if (key === "ArrowRight") {
    return { kind: "next" };
  }
  if (key === "Enter") {
    return { kind: "confirm" };
  }
  if (key === "Escape") {
    return { kind: "close" };
  }
  return undefined;
}

/** `S` and `s` both skip; delete and reapply need Shift so they are hard to hit by accident. */
export function itemActionForKey(press: KeyPress, classNames: string[]): ItemAction | undefined {
  if (hasCommandModifier(press)) {
    return undefined;
  }
  const name = classForDigit(press.key, classNames);
  if (name !== undefined) {
    return { kind: "toggleClass", name };
  }
  if (press.key === "s") {
    return { kind: "skip" };
  }
  if (press.shiftKey) {
    const shifted = shiftedAction(press.key);
    if (shifted) {
      return shifted;
    }
  }
  return navigationAction(press.key);
}

export type GridAction = { kind: "assign" } | { kind: "skip" } | { kind: "delete" } | { kind: "clear" };

/** Grid shortcuts only apply while something is selected. */
export function gridActionForKey(press: KeyPress, hasSelection: boolean): GridAction | undefined {
  if (!hasSelection || hasCommandModifier(press)) {
    return undefined;
  }
  if (press.key === "l" || press.key === "L") {
    return { kind: "assign" };
  }
  if (press.key === "S" && press.shiftKey) {
    return { kind: "skip" };
  }
  if (press.key === "D" && press.shiftKey) {
    return { kind: "delete" };
  }
  if (press.key === "Escape") {
    return { kind: "clear" };
  }
  return undefined;
}
