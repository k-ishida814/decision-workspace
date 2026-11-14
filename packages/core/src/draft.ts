/**
 * Decisions written by Claude or the Planner (T-309, T-311): options by label, dependencies by
 * key or existing id, conditions by option label. Converted to NewDecision with stable option
 * ids ("1", "2", …). Pure; throws DraftError with a message the author can act on.
 */
import type { Decision, NewDecision } from "@dw/protocol";

export type DraftDecision = {
  key: string;
  title?: string;
  question: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
  /** Label of the recommended option. */
  recommended?: string;
  dependsOn?: { ref: string; whenOptions?: string[] }[];
};

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

const isId = (ref: string) => /^D-\d+$/.test(ref);

/**
 * @param existing decisions referenced by id (D-n), to resolve their option labels
 * @param source who proposed the options
 */
export function fromDrafts(
  drafts: readonly DraftDecision[],
  existing: ReadonlyMap<string, Decision>,
  source: "claude" | "user",
): NewDecision[] {
  const byKey = new Map(drafts.map((d) => [d.key, d]));
  const optionId = (ref: string, label: string): string => {
    if (isId(ref)) {
      const parent = existing.get(ref);
      if (!parent) throw new DraftError(`unknown decision ${ref}`);
      const option = parent.options.find((o) => o.label === label || o.id === label);
      if (!option) {
        throw new DraftError(
          `${ref} has no option "${label}" (has: ${parent.options.map((o) => o.label).join(", ")})`,
        );
      }
      return option.id;
    }
    const local = byKey.get(ref);
    if (!local) throw new DraftError(`unknown key "${ref}"`);
    const labels = (local.options ?? []).map((o) => o.label);
    const index = labels.indexOf(label);
    if (index < 0)
      throw new DraftError(`"${ref}" has no option "${label}" (has: ${labels.join(", ")})`);
    return String(index + 1);
  };

  return drafts.map((d) => {
    const options = (d.options ?? []).map((o, i) => ({
      id: String(i + 1),
      label: o.label,
      description: o.description || undefined,
      source,
      ...(d.recommended !== undefined && o.label === d.recommended ? { recommended: true } : {}),
    }));
    return {
      key: d.key,
      title: d.title ?? "",
      question: d.question,
      kind: options.length === 0 ? "text" : d.multiSelect ? "multi" : "single",
      options,
      dependsOn: (d.dependsOn ?? []).map((dep) => ({
        ref: dep.ref,
        whenOptions:
          dep.whenOptions && dep.whenOptions.length > 0
            ? dep.whenOptions.map((label) => optionId(dep.ref, label))
            : undefined,
      })),
    };
  });
}

/** Ids (D-n) the drafts depend on, to fetch before calling fromDrafts. */
export function referencedIds(drafts: readonly DraftDecision[]): string[] {
  return [...new Set(drafts.flatMap((d) => (d.dependsOn ?? []).map((x) => x.ref)).filter(isId))];
}
