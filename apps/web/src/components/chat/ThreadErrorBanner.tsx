import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, InfoIcon, XIcon } from "lucide-react";

const RECOVERY_RESTART_ERROR_PREFIX = "The app closed while this thread was working";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const isRecoveryNotice = error.startsWith(RECOVERY_RESTART_ERROR_PREFIX);
  const Icon = isRecoveryNotice ? InfoIcon : CircleAlertIcon;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={isRecoveryNotice ? "warning" : "error"}>
        <Icon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss error"
              className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
