import { cn } from "~/lib/utils";

export function WorkingDots({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex items-center gap-0.5 text-current", className)}
    >
      <span className="size-1 rounded-full bg-current opacity-30 animate-pulse" />
      <span className="size-1 rounded-full bg-current opacity-30 animate-pulse [animation-delay:150ms]" />
      <span className="size-1 rounded-full bg-current opacity-30 animate-pulse [animation-delay:300ms]" />
    </span>
  );
}
