export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:";

export interface MessageVisibilityInput {
  source?: string | undefined;
  text: string;
}

export function isUserAuthoredMessage(input: MessageVisibilityInput): boolean {
  return (
    input.source !== "harness" &&
    !input.text.trimStart().startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)
  );
}
