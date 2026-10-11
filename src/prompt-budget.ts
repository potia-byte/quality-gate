import { defaultConfig, type QualityGateConfig } from "./config.js";

export interface PromptUsage {
  budgetChars: number;
  promptChars: number;
  promptUtf8Bytes: number;
  includedSections: string[];
  truncatedSections: string[];
  omittedSections: string[];
}

export interface BuiltPrompt {
  prompt: string;
  usage: PromptUsage;
}

export interface PromptSection {
  name: string;
  text: string;
  /** An optional section is dropped (not an error) when it does not fit. */
  optional?: boolean;
  preTruncated?: boolean;
}

function truncateSection(text: string, chars: number, name: string): string {
  const marker = `\n[${name} truncated to context budget]`;
  if (chars <= marker.length) return marker.slice(0, chars);
  return `${text.slice(0, chars - marker.length)}${marker}`;
}

/**
 * Packs sections in order into a character budget. A required section that
 * cannot fit throws; an optional one is omitted and reported.
 */
export function fitPromptSections(
  sections: PromptSection[],
  budgetChars: number,
): BuiltPrompt {
  const includedSections: string[] = [];
  const truncatedSections: string[] = [];
  const omittedSections: string[] = [];
  const parts: string[] = [];
  let remaining = budgetChars;

  for (const section of sections) {
    const separator = parts.length === 0 ? "" : "\n\n";
    const available = remaining - separator.length;
    if (available <= 0) {
      omittedSections.push(section.name);
      continue;
    }
    if (section.text.length <= available) {
      parts.push(`${separator}${section.text}`);
      remaining -= separator.length + section.text.length;
      includedSections.push(section.name);
      if (section.preTruncated) truncatedSections.push(section.name);
      continue;
    }
    if (section.optional) {
      omittedSections.push(section.name);
      continue;
    }
    throw new Error(
      `Context budget ${budgetChars} is too small for required prompt section ${section.name}.`,
    );
  }

  const prompt = parts.join("");
  return {
    prompt,
    usage: {
      budgetChars,
      promptChars: prompt.length,
      promptUtf8Bytes: Buffer.byteLength(prompt, "utf8"),
      includedSections,
      truncatedSections,
      omittedSections,
    },
  };
}

export function boundedPromptSection(
  name: string,
  text: string,
  maxChars: number,
): PromptSection {
  return text.length <= maxChars
    ? { name, text }
    : {
        name,
        text: truncateSection(text, maxChars, name),
        preTruncated: true,
      };
}

/**
 * Remaining cumulative prompt budget of a run, floored at
 * `qa.minContextBudgetChars` so that a late legitimate attempt can still fit
 * its required sections instead of shrinking to zero.
 */
export function remainingRunContextBudget(
  run:
    | {
        context_budget_chars?: number | undefined;
        context_usage?: Array<{ prompt_chars: number }> | undefined;
      }
    | undefined,
  config: QualityGateConfig = defaultConfig,
): number {
  const ceiling = run?.context_budget_chars ?? config.qa.runContextBudgetChars;
  const used =
    run?.context_usage?.reduce((sum, item) => sum + item.prompt_chars, 0) ?? 0;
  return Math.max(config.qa.minContextBudgetChars, Math.max(0, ceiling - used));
}
