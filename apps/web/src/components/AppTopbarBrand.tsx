import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

export const AppTopbarBrand = memo(function AppTopbarBrand() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label="Go to threads"
            className="flex min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
            to="/"
          >
            <T3Wordmark />
            <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
              Code
            </span>
            <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
              {APP_STAGE_LABEL}
            </span>
          </Link>
        }
      />
      <TooltipPopup side="bottom" sideOffset={2}>
        Version {APP_VERSION}
      </TooltipPopup>
    </Tooltip>
  );
});
