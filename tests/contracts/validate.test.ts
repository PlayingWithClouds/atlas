import { describe, expect, test } from "bun:test";
import { isGroupActive, removedIds, validateAnnotation, validateTaxonomy } from "../../packages/contracts/src/index";
import type { AnnotationInput, Taxonomy } from "../../packages/contracts/src/index";

const taxonomy: Taxonomy = {
  version: 3,
  groups: [
    { id: "rating", label: "Rating", kind: "single", primary: true, labels: [
      { id: "sfw", name: "SFW", hotkey: "q" }, { id: "explicit", name: "Explicit", hotkey: "w" },
    ] },
    { id: "act", label: "Act", kind: "multi", primary: true, labels: [
      { id: "blowjob", name: "Blowjob" }, { id: "kissing", name: "Kissing" },
    ] },
    { id: "oral_intensity", label: "Oral intensity", kind: "single", when: { group: "act", label: "blowjob" }, labels: [
      { id: "regular", name: "Regular" }, { id: "deepthroat", name: "Deepthroat" },
    ] },
  ],
};

function input(overrides: Partial<AnnotationInput>): AnnotationInput {
  return { status: "labeled", values: {}, reviewed: [], ...overrides };
}

describe("validateTaxonomy", () => {
  test("accepts a valid taxonomy", () => {
    expect(validateTaxonomy(taxonomy)).toEqual([]);
  });

  test("rejects duplicate ids, bad conditions and hotkeys", () => {
    const problems = validateTaxonomy({ groups: [
      { id: "a", label: "A", kind: "single", labels: [{ id: "x", name: "X", hotkey: "k" }, { id: "x", name: "X2", hotkey: "k" }] },
      { id: "b", label: "B", kind: "multi", when: { group: "a", label: "missing" }, labels: [] },
      { id: "c", label: "C", kind: "multi", when: { group: "b", label: "y" }, labels: [] },
    ] });
    expect(problems).toContain('label "a.x" is defined twice');
    expect(problems).toContain('hotkey "k" is used twice in group "a"');
    expect(problems).toContain('group "b" depends on unknown label "a.missing"');
    expect(problems).toContain('group "c" depends on "b", which has a condition itself');
  });

  test("lists ids a new version drops", () => {
    const next = { groups: [{ ...taxonomy.groups[0], labels: [taxonomy.groups[0].labels[0]] }] };
    expect(removedIds(taxonomy, next)).toEqual(["rating.explicit", "act", "act.blowjob", "act.kissing",
      "oral_intensity", "oral_intensity.regular", "oral_intensity.deepthroat"]);
  });
});

describe("validateAnnotation", () => {
  test("accepts labels with their conditions met", () => {
    const annotation = input({
      values: { rating: ["explicit"], act: ["blowjob"], oral_intensity: ["deepthroat"] },
      reviewed: ["rating", "act", "oral_intensity"],
    });
    expect(validateAnnotation(taxonomy, annotation, 30)).toEqual([]);
  });

  test("a reviewed group without values is fine", () => {
    expect(validateAnnotation(taxonomy, input({ reviewed: ["act"] }), 30)).toEqual([]);
  });

  test("rejects two labels in a single group and unknown ids", () => {
    const problems = validateAnnotation(taxonomy, input({
      values: { rating: ["sfw", "explicit"], act: ["nope"], other: ["x"] },
      reviewed: ["rating", "act"],
    }));
    expect(problems).toContain('group "rating" takes one label, got 2');
    expect(problems).toContain('unknown label "act.nope"');
    expect(problems).toContain('unknown group "other"');
  });

  test("rejects a conditional group whose condition is unmet", () => {
    const problems = validateAnnotation(taxonomy, input({
      values: { act: ["kissing"], oral_intensity: ["regular"] },
      reviewed: ["act", "oral_intensity"],
    }));
    expect(problems).toContain('group "oral_intensity" is reviewed but its condition is not met');
    expect(problems).toContain('group "oral_intensity" has labels but its condition is not met');
  });

  test("labels imply review", () => {
    const problems = validateAnnotation(taxonomy, input({ values: { act: ["kissing"] } }));
    expect(problems).toEqual(['group "act" has labels but is not in reviewed']);
  });

  test("checks ranges against the item and single-group overlap", () => {
    const problems = validateAnnotation(taxonomy, input({
      reviewed: ["rating", "act"],
      ranges: [
        { group: "rating", label: "sfw", start: 0, end: 10 },
        { group: "rating", label: "explicit", start: 8, end: 20 },
        { group: "act", label: "kissing", start: 25, end: 40 },
      ],
    }), 30);
    expect(problems).toContain('ranges of single-choice group "rating" overlap');
    expect(problems).toContain('range "act.kissing" ends after the item (30.00 s)');
  });

  test("a skipped item carries nothing", () => {
    expect(validateAnnotation(taxonomy, input({ status: "skipped" }))).toEqual([]);
    expect(validateAnnotation(taxonomy, input({ status: "skipped", reviewed: ["act"] })))
      .toEqual(["a skipped item has no values, ranges or reviewed groups"]);
  });
});

test("isGroupActive follows the condition", () => {
  const conditional = taxonomy.groups[2];
  expect(isGroupActive(conditional, { act: ["blowjob"] })).toBe(true);
  expect(isGroupActive(conditional, { act: ["kissing"] })).toBe(false);
  expect(isGroupActive(conditional, {})).toBe(false);
  expect(isGroupActive(taxonomy.groups[0], {})).toBe(true);
  expect(isGroupActive(conditional, {}, [{ group: "act", label: "blowjob", start: 1, end: 3 }])).toBe(true);
  expect(isGroupActive(conditional, {}, [{ group: "act", label: "kissing", start: 1, end: 3 }])).toBe(false);
});
