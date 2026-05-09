import { PlusIcon, QrCodeIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AuthClientSession,
  type AuthPairingLink,
  type DesktopServerExposureState,
  type EnvironmentId,
  type HistorySyncConfig,
  type HistorySyncInitialSyncRecovery,
  type HistorySyncProjectMappingPlan,
} from "@t3tools/contracts";
import { DateTime } from "effect";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { isHistorySyncAutosaveRemoteConflictStatus } from "../HistorySyncTopbarStatus";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import {
  createServerPairingCredential,
  fetchSessionState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import {
  buildHistorySyncProjectMappingActions,
  draftFromPlanCandidate,
  type HistorySyncMappingDraft,
} from "../../historySyncProjectMapping";
import type { WsRpcClient } from "~/rpc/wsRpcClient";
import { ensureLocalApi } from "../../localApi";
import { useServerConfig } from "../../rpc/serverState";
import {
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  addSavedEnvironment,
  getPrimaryEnvironmentConnection,
  refreshPrimaryEnvironmentProjectionSnapshot,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
} from "~/environments/runtime";

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

export function getHistorySyncInitialRecoveryPhaseLabel(
  phase: HistorySyncInitialSyncRecovery["phase"],
): string {
  switch (phase) {
    case "backup":
      return "Creating backup";
    case "push-local":
      return "Pushing local history";
    case "push-merge":
      return "Pushing merged local history";
    case "import-remote":
      return "Importing remote history";
    case "write-state":
      return "Saving sync state";
  }
}

export function formatHistorySyncInitialRecoveryStartedAt(value: string): string {
  return formatAccessTimestamp(value);
}

export function getHistorySyncInitialRecoveryActionCopy(
  recovery: HistorySyncInitialSyncRecovery,
): string {
  return recovery.error
    ? "Review the error, then start history sync again when ready."
    : "Start history sync again to continue from the current safe recovery point.";
}

export function getHistorySyncStatusText(status: HistorySyncConfig["status"] | null): string {
  if (status === null) return "Loading...";
  if (isHistorySyncAutosaveRemoteConflictStatus(status)) {
    return "Autosave paused; use Sync now to import remote changes.";
  }
  if (status.state === "error") return status.message;
  if (status.state === "needs-project-mapping") {
    return `${status.unresolvedProjectCount} project mapping${
      status.unresolvedProjectCount === 1 ? "" : "s"
    } needed`;
  }
  if (status.state === "syncing") {
    return status.progress?.label ?? "Syncing history";
  }
  if (status.state === "needs-initial-sync") return "Ready to start";
  return status.state;
}

export function getHistorySyncStatusTextClassName(
  status: HistorySyncConfig["status"] | null,
): string | undefined {
  if (!status) return undefined;
  if (isHistorySyncAutosaveRemoteConflictStatus(status)) return "text-amber-700";
  return status.state === "error" ? "text-destructive" : undefined;
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      title={tooltipText}
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}

function getSavedBackendStatusTooltip(
  runtime: SavedEnvironmentRuntimeState | null,
  record: SavedEnvironmentRecord,
  nowMs: number,
) {
  const connectionState = runtime?.connectionState ?? "disconnected";

  if (connectionState === "connected") {
    const connectedAt = runtime?.connectedAt ?? record.lastConnectedAt;
    return connectedAt ? `Connected for ${formatElapsedDurationLabel(connectedAt, nowMs)}` : null;
  }

  if (connectionState === "connecting") {
    return null;
  }

  if (connectionState === "error") {
    return runtime?.lastError ?? "An unknown connection error occurred.";
  }

  return record.lastConnectedAt
    ? `Last connected at ${formatAccessTimestamp(record.lastConnectedAt)}`
    : "Not connected yet.";
}

/** Direct row in the card – same pattern as the Provider / ACP-agent list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

function upsertDesktopPairingLink(
  current: ReadonlyArray<ServerPairingLinkRecord>,
  next: ServerPairingLinkRecord,
) {
  const existingIndex = current.findIndex((pairingLink) => pairingLink.id === next.id);
  if (existingIndex === -1) {
    return sortDesktopPairingLinks([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopPairingLinks(updated);
}

function removeDesktopPairingLink(current: ReadonlyArray<ServerPairingLinkRecord>, id: string) {
  return current.filter((pairingLink) => pairingLink.id !== id);
}

function upsertDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  next: ServerClientSessionRecord,
) {
  const existingIndex = current.findIndex(
    (clientSession) => clientSession.sessionId === next.sessionId,
  );
  if (existingIndex === -1) {
    return sortDesktopClientSessions([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopClientSessions(updated);
}

function removeDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  sessionId: ServerClientSessionRecord["sessionId"],
) {
  return current.filter((clientSession) => clientSession.sessionId !== sessionId);
}

function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);

  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const shareablePairingUrl =
    endpointUrl != null && endpointUrl !== ""
      ? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential)
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl;
  const copyValue = shareablePairingUrl ?? pairingLink.credential;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: shareablePairingUrl ? "Pairing URL copied" : "Pairing token copied",
        description: shareablePairingUrl
          ? "Open it in the client you want to pair to this environment."
          : "Paste it into another client with this backend's reachable host.",
      });
    },
    onError: (error) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard ? "Could not copy pairing URL" : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const handleCopy = useCallback(() => {
    copyToClipboard(copyValue, undefined);
  }, [copyToClipboard, copyValue]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const roleLabel = pairingLink.role === "owner" ? "Owner" : "Client";
  const primaryLabel = pairingLink.label ?? `${roleLabel} link`;

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            <Popover>
              {shareablePairingUrl ? (
                <>
                  <PopoverTrigger
                    openOnHover
                    delay={250}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:text-foreground"
                        aria-label="Show QR code"
                      />
                    }
                  >
                    <QrCodeIcon aria-hidden className="size-3" />
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={88}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </PopoverPopup>
                </>
              ) : null}
            </Popover>
          </div>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {[roleLabel, formatExpiresInLabel(pairingLink.expiresAt, nowMs)].join(" · ")}
          </p>
          {shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground/70">
              Copy the token and pair from another client using this backend&apos;s reachable host.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard ? (
              <Button size="xs" variant="outline" onClick={handleCopy}>
                {isCopied ? "Copied" : shareablePairingUrl ? "Copy" : "Copy token"}
              </Button>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? "Show link" : "Show token"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>{shareablePairingUrl ? "Pairing link" : "Pairing token"}</DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect."
                    : "Clipboard copy is unavailable here. Manually copy this token and pair from another client using this backend's reachable host."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={copyValue}
                  rows={shareablePairingUrl ? 4 : 3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {shareablePairingUrl ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" size="xs" onClick={handleCopy}>
                    {isCopied ? "Copied" : "Copy again"}
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : "Connected"
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : "Not connected yet.";
  const roleLabel = clientSession.role === "owner" ? "Owner" : "Client";
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-[10px] text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {[roleLabel, ...deviceInfoBits].join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createServerPairingCredential(pairingLabel);
      setPairingLabel("");
      setDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing URL",
          description: message,
        }),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel]);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "Revoking…" : "Revoke others"}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Create link
            </Button>
          }
        />
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time link that another device can use to pair with this backend as an
              authorized client.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Client label (optional)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="e.g. Living room iPad"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={isCreatingPairingLink} onClick={() => void handleCreatePairingLink()}>
              {isCreatingPairingLink ? "Creating…" : "Create link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  endpointUrl: string | null | undefined;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  isLoading,
  pairingLinks,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          endpointUrl={endpointUrl}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
        </div>
      ) : null}
    </>
  );
});

type SavedBackendListRowProps = {
  environmentId: EnvironmentId;
  reconnectingEnvironmentId: EnvironmentId | null;
  removingEnvironmentId: EnvironmentId | null;
  onReconnect: (environmentId: EnvironmentId) => void;
  onRemove: (environmentId: EnvironmentId) => void;
};

function SavedBackendListRow({
  environmentId,
  reconnectingEnvironmentId,
  removingEnvironmentId,
  onReconnect,
  onRemove,
}: SavedBackendListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId] ?? null);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId] ?? null);

  if (!record) {
    return null;
  }

  const connectionState = runtime?.connectionState ?? "disconnected";
  const stateDotClassName =
    connectionState === "connected"
      ? "bg-success"
      : connectionState === "connecting"
        ? "bg-warning"
        : connectionState === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  const roleLabel = runtime?.role ? (runtime.role === "owner" ? "Owner" : "Client") : null;
  const descriptorLabel = runtime?.descriptor?.label ?? null;
  const statusTooltip = getSavedBackendStatusTooltip(runtime, record, nowMs);
  const metadataBits = [
    roleLabel,
    record.lastConnectedAt
      ? `Last connected ${formatAccessTimestamp(record.lastConnectedAt)}`
      : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={stateDotClassName}
              pingClassName={
                connectionState === "connecting" ? "bg-warning/60 duration-2000" : null
              }
            />
            <h3 className="text-sm font-medium text-foreground">{record.label}</h3>
          </div>
          {metadataBits.length > 0 ? (
            <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
          ) : null}
          {descriptorLabel && descriptorLabel !== record.label ? (
            <p className="text-xs text-muted-foreground">Server label: {descriptorLabel}</p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={reconnectingEnvironmentId === environmentId}
            onClick={() => void onReconnect(environmentId)}
          >
            {reconnectingEnvironmentId === environmentId ? "Reconnecting…" : "Reconnect"}
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={removingEnvironmentId === environmentId}
            onClick={() => void onRemove(environmentId)}
          >
            {removingEnvironmentId === environmentId ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}

type HistorySyncFormState = {
  enabled: boolean;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  tlsEnabled: boolean;
  shutdownFlushTimeoutMs: string;
  statusIndicatorEnabled: boolean;
};

const emptyHistorySyncForm: HistorySyncFormState = {
  enabled: false,
  host: "",
  port: "3306",
  database: "",
  username: "",
  password: "",
  tlsEnabled: false,
  shutdownFlushTimeoutMs: "5000",
  statusIndicatorEnabled: true,
};

function historySyncFormFromConfig(config: HistorySyncConfig): HistorySyncFormState {
  return {
    enabled: config.enabled,
    host: config.connectionSummary?.host ?? "",
    port: String(config.connectionSummary?.port ?? 3306),
    database: config.connectionSummary?.database ?? "",
    username: config.connectionSummary?.username ?? "",
    password: "",
    tlsEnabled: config.connectionSummary?.tlsEnabled ?? false,
    shutdownFlushTimeoutMs: String(config.shutdownFlushTimeoutMs),
    statusIndicatorEnabled: config.statusIndicatorEnabled,
  };
}

function HistorySyncSettingsSection() {
  const liveHistorySyncStatus = useServerConfig()?.historySync ?? null;
  const [config, setConfig] = useState<HistorySyncConfig | null>(null);
  const [form, setForm] = useState<HistorySyncFormState>(emptyHistorySyncForm);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningSync, setIsRunningSync] = useState(false);
  const [isStartingInitialSync, setIsStartingInitialSync] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [mappingPlan, setMappingPlan] = useState<HistorySyncProjectMappingPlan | null>(null);
  const [mappingDraftByProjectId, setMappingDraftByProjectId] = useState<
    Record<string, HistorySyncMappingDraft>
  >({});
  const [isLoadingMappings, setIsLoadingMappings] = useState(false);
  const [isApplyingMappings, setIsApplyingMappings] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const next = await ensureLocalApi().server.getHistorySyncConfig();
      setConfig(next);
      setForm(historySyncFormFromConfig(next));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load history sync.");
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadMappingPlan = useCallback(async () => {
    setIsLoadingMappings(true);
    try {
      const next = await ensureLocalApi().server.getHistorySyncProjectMappings();
      setMappingPlan(next);
      setMappingDraftByProjectId(
        Object.fromEntries(
          next.candidates
            .filter((candidate) => candidate.status === "unresolved")
            .map((candidate) => [candidate.remoteProjectId, draftFromPlanCandidate(candidate)]),
        ),
      );
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load project mappings.");
    } finally {
      setIsLoadingMappings(false);
    }
  }, []);

  useEffect(() => {
    if (config?.status.state === "needs-project-mapping") {
      void loadMappingPlan();
    }
  }, [config?.status.state, loadMappingPlan]);

  const buildMysql = useCallback(() => {
    const port = Number(form.port);
    return {
      host: form.host.trim(),
      port,
      database: form.database.trim(),
      username: form.username.trim(),
      password: form.password,
      tlsEnabled: form.tlsEnabled,
    };
  }, [form]);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setError(null);
    try {
      const result = await ensureLocalApi().server.testHistorySyncConnection({
        mysql: buildMysql(),
      });
      if (!result.success) {
        setError(result.message ?? "Connection test failed.");
        return;
      }
      toastManager.add({ type: "success", title: "Connection verified" });
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Connection test failed.");
    } finally {
      setIsTesting(false);
    }
  }, [buildMysql]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const shutdownFlushTimeoutMs = Number(form.shutdownFlushTimeoutMs);
      const summaryChanged =
        config?.connectionSummary?.host !== form.host.trim() ||
        String(config?.connectionSummary?.port ?? 3306) !== form.port ||
        config?.connectionSummary?.database !== form.database.trim() ||
        config?.connectionSummary?.username !== form.username.trim() ||
        (config?.connectionSummary?.tlsEnabled ?? false) !== form.tlsEnabled;
      const shouldSendMysql = form.password.length > 0 || !config?.configured || summaryChanged;
      if (form.enabled && !config?.configured && form.password.length === 0) {
        throw new Error("Save a verified MySQL connection before enabling history sync.");
      }
      if (shouldSendMysql && form.password.length === 0) {
        throw new Error("Password is required when creating or changing the MySQL connection.");
      }
      const next = await ensureLocalApi().server.updateHistorySyncConfig({
        settings: {
          enabled: form.enabled,
          shutdownFlushTimeoutMs,
          statusIndicatorEnabled: form.statusIndicatorEnabled,
        },
        ...(shouldSendMysql ? { mysql: buildMysql() } : {}),
      });
      setConfig(next);
      setForm(historySyncFormFromConfig(next));
      toastManager.add({ type: "success", title: "History sync saved" });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save history sync.");
    } finally {
      setIsSaving(false);
    }
  }, [buildMysql, config, form]);

  const handleClear = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const next = await ensureLocalApi().server.updateHistorySyncConfig({
        settings: { enabled: false },
        clearConnection: true,
      });
      setConfig(next);
      setForm(historySyncFormFromConfig(next));
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "Failed to clear connection.");
    } finally {
      setIsSaving(false);
    }
  }, []);

  const handleStartInitialSync = useCallback(async () => {
    setIsStartingInitialSync(true);
    setError(null);
    try {
      const next = await ensureLocalApi().server.startHistorySyncInitialImport();
      setConfig(next);
      setForm(historySyncFormFromConfig(next));
      toastManager.add({ type: "success", title: "History sync started" });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start history sync.");
    } finally {
      setIsStartingInitialSync(false);
    }
  }, []);

  const handleRunSync = useCallback(async () => {
    setIsRunningSync(true);
    setError(null);
    try {
      const next = await ensureLocalApi().server.runHistorySync();
      setConfig(next);
      setForm(historySyncFormFromConfig(next));
      toastManager.add({ type: "success", title: "History sync started" });
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Failed to sync history.");
    } finally {
      setIsRunningSync(false);
    }
  }, []);

  const handleRestoreBackup = useCallback(async () => {
    setIsRestoringBackup(true);
    setError(null);
    try {
      const next = await ensureLocalApi().server.restoreHistorySyncBackup();
      setConfig(next);
      setForm(historySyncFormFromConfig(next));
      await refreshPrimaryEnvironmentProjectionSnapshot();
      toastManager.add({ type: "success", title: "History sync backup restored" });
    } catch (restoreError) {
      setError(
        restoreError instanceof Error ? restoreError.message : "Failed to restore history backup.",
      );
    } finally {
      setIsRestoringBackup(false);
    }
  }, []);

  const handlePickMappingFolder = useCallback(
    async (remoteProjectId: string) => {
      const folder = await ensureLocalApi().dialogs.pickFolder();
      if (!folder) return;
      const candidate = mappingPlan?.candidates.find(
        (entry) => entry.remoteProjectId === remoteProjectId,
      );
      setMappingDraftByProjectId((current) => ({
        ...current,
        [remoteProjectId]: {
          action: "map-folder",
          workspaceRoot: folder,
          title: candidate?.remoteTitle ?? "",
        },
      }));
    },
    [mappingPlan],
  );

  const handleApplyMappings = useCallback(async () => {
    if (!mappingPlan) return;
    setIsApplyingMappings(true);
    setError(null);
    try {
      const actions = buildHistorySyncProjectMappingActions(mappingPlan, mappingDraftByProjectId);
      const next = await ensureLocalApi().server.applyHistorySyncProjectMappings({
        syncId: mappingPlan.syncId,
        actions,
      });
      setMappingPlan(next);
      await loadConfig();
      toastManager.add({ type: "success", title: "Project mappings saved" });
    } catch (applyError) {
      setError(
        applyError instanceof Error ? applyError.message : "Failed to apply project mappings.",
      );
    } finally {
      setIsApplyingMappings(false);
    }
  }, [loadConfig, mappingDraftByProjectId, mappingPlan]);

  const effectiveHistorySyncStatus = liveHistorySyncStatus ?? config?.status ?? null;
  const statusText = getHistorySyncStatusText(effectiveHistorySyncStatus);
  const syncProgress =
    effectiveHistorySyncStatus?.state === "syncing" ? effectiveHistorySyncStatus.progress : null;
  const isHistorySyncing = effectiveHistorySyncStatus?.state === "syncing";
  const unresolvedMappingCandidates =
    mappingPlan?.candidates.filter((candidate) => candidate.status === "unresolved") ?? [];
  const showInitialSyncAction =
    config?.configured === true && effectiveHistorySyncStatus?.state === "needs-initial-sync";
  const showSyncAction = config?.configured === true;
  const showBackupRestoreAction = Boolean(config?.backup) && !isHistorySyncing;
  const initialSyncRecovery = config?.initialSyncRecovery ?? null;

  return (
    <SettingsSection title="History Sync">
      <SettingsRow
        title="Enable sync"
        description={
          config?.configured
            ? "Sync history with the configured MySQL database."
            : "Configure and save a MySQL connection first."
        }
        status={
          <span className={getHistorySyncStatusTextClassName(effectiveHistorySyncStatus)}>
            {statusText}
          </span>
        }
        control={
          <Switch
            checked={form.enabled}
            disabled={!config}
            onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
            aria-label="Enable history sync"
          />
        }
      />
      {showSyncAction || showBackupRestoreAction ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {showInitialSyncAction ? (
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-foreground">Initial history sync</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Back up local threads, import the MySQL history, then merge the local threads
                    back.
                  </p>
                </div>
              ) : (
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-foreground">History sync</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Fast-forward from MySQL, then persist safe local thread updates.
                  </p>
                </div>
              )}
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                {showBackupRestoreAction ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      isRestoringBackup ||
                      isStartingInitialSync ||
                      isRunningSync ||
                      isSaving ||
                      isTesting
                    }
                    onClick={() => void handleRestoreBackup()}
                  >
                    {isRestoringBackup ? "Restoring..." : "Restore backup"}
                  </Button>
                ) : null}
                {showInitialSyncAction ? (
                  <Button
                    size="xs"
                    disabled={
                      isStartingInitialSync ||
                      isRestoringBackup ||
                      isRunningSync ||
                      isSaving ||
                      isTesting ||
                      !config.configured
                    }
                    onClick={() => void handleStartInitialSync()}
                  >
                    {isStartingInitialSync ? "Starting..." : "Start history sync"}
                  </Button>
                ) : showSyncAction ? (
                  <Button
                    size="xs"
                    disabled={
                      isRunningSync ||
                      isHistorySyncing ||
                      isStartingInitialSync ||
                      isRestoringBackup ||
                      isSaving ||
                      isTesting
                    }
                    onClick={() => void handleRunSync()}
                  >
                    {isRunningSync || isHistorySyncing ? "Syncing..." : "Sync now"}
                  </Button>
                ) : null}
              </div>
            </div>
            {initialSyncRecovery ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
                <div className="font-medium">Initial sync recovery point</div>
                <div className="mt-1 text-muted-foreground">
                  {getHistorySyncInitialRecoveryPhaseLabel(initialSyncRecovery.phase)} started{" "}
                  {formatHistorySyncInitialRecoveryStartedAt(initialSyncRecovery.startedAt)}.
                </div>
                {initialSyncRecovery.error ? (
                  <div className="mt-1 break-words text-destructive">
                    {initialSyncRecovery.error}
                  </div>
                ) : null}
                <div className="mt-1 text-muted-foreground">
                  {getHistorySyncInitialRecoveryActionCopy(initialSyncRecovery)}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {syncProgress ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-muted-foreground">{syncProgress.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {syncProgress.current}/{syncProgress.total}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-300"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(0, (syncProgress.current / Math.max(1, syncProgress.total)) * 100),
                  )}%`,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
      {effectiveHistorySyncStatus?.state === "needs-project-mapping" ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">Map synced projects</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the local folder or project that matches each remote project.
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={isLoadingMappings}
                onClick={() => void loadMappingPlan()}
              >
                {isLoadingMappings ? "Loading..." : "Refresh"}
              </Button>
            </div>
            {unresolvedMappingCandidates.map((candidate) => {
              const draft =
                mappingDraftByProjectId[candidate.remoteProjectId] ??
                draftFromPlanCandidate(candidate);
              return (
                <div
                  key={candidate.remoteProjectId}
                  className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {candidate.remoteTitle}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {candidate.remoteWorkspaceRoot}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {candidate.threadCount} thread{candidate.threadCount === 1 ? "" : "s"}
                      {candidate.suggestionReason
                        ? ` - suggested by ${candidate.suggestionReason.replace("-", " ")}`
                        : ""}
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                    <select
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                      value={draft.action}
                      disabled={isApplyingMappings}
                      onChange={(event) => {
                        const action = event.currentTarget
                          .value as HistorySyncMappingDraft["action"];
                        setMappingDraftByProjectId((current) => ({
                          ...current,
                          [candidate.remoteProjectId]:
                            action === "map-existing"
                              ? {
                                  action,
                                  localProjectId:
                                    candidate.suggestedLocalProjectId ??
                                    mappingPlan?.localProjects[0]?.projectId ??
                                    "",
                                }
                              : action === "skip"
                                ? { action }
                                : {
                                    action,
                                    workspaceRoot: "",
                                    title: candidate.remoteTitle,
                                  },
                        }));
                      }}
                    >
                      <option value="map-existing">Existing project</option>
                      <option value="map-folder">Local folder</option>
                      <option value="skip">Skip</option>
                    </select>
                    {draft.action === "map-existing" ? (
                      <select
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                        value={draft.localProjectId}
                        disabled={isApplyingMappings}
                        onChange={(event) =>
                          setMappingDraftByProjectId((current) => ({
                            ...current,
                            [candidate.remoteProjectId]: {
                              action: "map-existing",
                              localProjectId: event.currentTarget.value,
                            },
                          }))
                        }
                      >
                        {mappingPlan?.localProjects.map((project) => (
                          <option key={project.projectId} value={project.projectId}>
                            {project.title} - {project.workspaceRoot}
                          </option>
                        ))}
                      </select>
                    ) : draft.action === "map-folder" ? (
                      <Input
                        value={draft.workspaceRoot}
                        placeholder="Local folder"
                        disabled={isApplyingMappings}
                        onChange={(event) =>
                          setMappingDraftByProjectId((current) => ({
                            ...current,
                            [candidate.remoteProjectId]: {
                              ...draft,
                              workspaceRoot: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    ) : (
                      <div className="flex h-8 items-center text-xs text-muted-foreground">
                        This project will stay only in MySQL for now.
                      </div>
                    )}
                    {draft.action === "map-folder" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={isApplyingMappings}
                        onClick={() => void handlePickMappingFolder(candidate.remoteProjectId)}
                      >
                        Browse
                      </Button>
                    ) : (
                      <span />
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex justify-end">
              <Button
                size="xs"
                disabled={
                  isApplyingMappings ||
                  isLoadingMappings ||
                  unresolvedMappingCandidates.length === 0
                }
                onClick={() => void handleApplyMappings()}
              >
                {isApplyingMappings ? "Applying..." : "Apply mappings"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <div className={ITEM_ROW_CLASSNAME}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={form.host}
            placeholder="Host"
            onChange={(event) => setForm((current) => ({ ...current, host: event.target.value }))}
          />
          <Input
            value={form.port}
            placeholder="3306"
            inputMode="numeric"
            onChange={(event) => setForm((current) => ({ ...current, port: event.target.value }))}
          />
          <Input
            value={form.database}
            placeholder="Database"
            onChange={(event) =>
              setForm((current) => ({ ...current, database: event.target.value }))
            }
          />
          <Input
            value={form.username}
            placeholder="Username"
            onChange={(event) =>
              setForm((current) => ({ ...current, username: event.target.value }))
            }
          />
          <Input
            value={form.password}
            placeholder={config?.configured ? "Password unchanged" : "Password"}
            type="password"
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
          />
          <Input
            value={form.shutdownFlushTimeoutMs}
            placeholder="Shutdown flush timeout (ms)"
            inputMode="numeric"
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                shutdownFlushTimeoutMs: event.target.value,
              }))
            }
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={form.tlsEnabled}
              onCheckedChange={(tlsEnabled) => setForm((current) => ({ ...current, tlsEnabled }))}
              aria-label="Enable MySQL TLS"
            />
            TLS
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={form.statusIndicatorEnabled}
              onCheckedChange={(statusIndicatorEnabled) =>
                setForm((current) => ({ ...current, statusIndicatorEnabled }))
              }
              aria-label="Show sync status indicator"
            />
            Status indicator
          </label>
          <div className="ml-auto flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={isTesting || isSaving}
              onClick={() => void handleTest()}
            >
              {isTesting ? "Testing..." : "Test connection"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={isSaving || !config?.configured}
              onClick={() => void handleClear()}
            >
              Clear connection
            </Button>
            <Button size="xs" disabled={isSaving || !config} onClick={() => void handleSave()}>
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
      </div>
    </SettingsSection>
  );
}

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const [currentSessionRole, setCurrentSessionRole] = useState<"owner" | "client" | null>(
    desktopBridge ? "owner" : null,
  );
  const [currentAuthPolicy, setCurrentAuthPolicy] = useState<
    "desktop-managed-local" | "loopback-browser" | "remote-reachable" | "unsafe-no-auth" | null
  >(desktopBridge ? null : null);
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentIds = useMemo(
    () =>
      Object.values(savedEnvironmentsById)
        .toSorted((left, right) => left.label.localeCompare(right.label))
        .map((record) => record.environmentId),
    [savedEnvironmentsById],
  );

  const [desktopServerExposureState, setDesktopServerExposureState] =
    useState<DesktopServerExposureState | null>(null);
  const [desktopServerExposureError, setDesktopServerExposureError] = useState<string | null>(null);
  const [desktopPairingLinks, setDesktopPairingLinks] = useState<
    ReadonlyArray<ServerPairingLinkRecord>
  >([]);
  const [desktopClientSessions, setDesktopClientSessions] = useState<
    ReadonlyArray<ServerClientSessionRecord>
  >([]);
  const [desktopAccessManagementError, setDesktopAccessManagementError] = useState<string | null>(
    null,
  );
  const [isLoadingDesktopAccessManagement, setIsLoadingDesktopAccessManagement] = useState(false);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  const [savedBackendMode, setSavedBackendMode] = useState<"pairing-url" | "host-code">(
    "pairing-url",
  );
  const [savedBackendLabel, setSavedBackendLabel] = useState("");
  const [savedBackendPairingUrl, setSavedBackendPairingUrl] = useState("");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const [reconnectingSavedEnvironmentId, setReconnectingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const canManageLocalBackend = currentSessionRole === "owner";
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureError(null);
      try {
        const nextState = await desktopBridge.setServerExposureMode(
          checked ? "network-accessible" : "local-only",
        );
        setDesktopServerExposureState(nextState);
        setPendingDesktopServerExposureMode(null);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to update network exposure.";
        setPendingDesktopServerExposureMode(null);
        setDesktopServerExposureError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update network access",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementError(null);
    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to revoke client access.";
        setDesktopAccessManagementError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke client access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke other clients",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  const handleAddSavedBackend = useCallback(async () => {
    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    try {
      const record = await addSavedEnvironment({
        label: savedBackendLabel,
        ...(savedBackendMode === "pairing-url"
          ? { pairingUrl: savedBackendPairingUrl }
          : {
              host: savedBackendHost,
              pairingCode: savedBackendPairingCode,
            }),
      });
      setSavedBackendLabel("");
      setSavedBackendPairingUrl("");
      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setAddBackendDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Backend added",
        description: `${record.label} is now saved and will reconnect on app startup.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
    } finally {
      setIsAddingSavedBackend(false);
    }
  }, [
    savedBackendHost,
    savedBackendLabel,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendPairingUrl,
  ]);

  const handleReconnectSavedBackend = useCallback(async (environmentId: EnvironmentId) => {
    setReconnectingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    try {
      await reconnectSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconnect backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect backend",
          description: message,
        }),
      );
    } finally {
      setReconnectingSavedEnvironmentId(null);
    }
  }, []);

  const handleRemoveSavedBackend = useCallback(async (environmentId: EnvironmentId) => {
    setRemovingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    try {
      await removeSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove backend",
          description: message,
        }),
      );
    } finally {
      setRemovingSavedEnvironmentId(null);
    }
  }, []);

  useEffect(() => {
    if (desktopBridge) {
      setCurrentSessionRole("owner");
      return;
    }

    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setCurrentSessionRole(session.authenticated ? (session.role ?? null) : null);
        setCurrentAuthPolicy(session.auth.policy);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentSessionRole(null);
        setCurrentAuthPolicy(null);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!canManageLocalBackend) return;

    let cancelled = false;
    setIsLoadingDesktopAccessManagement(true);
    type AuthAccessEvent = Parameters<
      Parameters<WsRpcClient["server"]["subscribeAuthAccess"]>[0]
    >[0];
    const unsubscribeAuthAccess =
      getPrimaryEnvironmentConnection().client.server.subscribeAuthAccess(
        (event: AuthAccessEvent) => {
          if (cancelled) {
            return;
          }

          switch (event.type) {
            case "snapshot":
              setDesktopPairingLinks(
                sortDesktopPairingLinks(
                  event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
                    toDesktopPairingLinkRecord(pairingLink),
                  ),
                ),
              );
              setDesktopClientSessions(
                sortDesktopClientSessions(
                  event.payload.clientSessions.map((clientSession: AuthClientSession) =>
                    toDesktopClientSessionRecord(clientSession),
                  ),
                ),
              );
              break;
            case "pairingLinkUpserted":
              setDesktopPairingLinks((current) =>
                upsertDesktopPairingLink(current, toDesktopPairingLinkRecord(event.payload)),
              );
              break;
            case "pairingLinkRemoved":
              setDesktopPairingLinks((current) =>
                removeDesktopPairingLink(current, event.payload.id),
              );
              break;
            case "clientUpserted":
              setDesktopClientSessions((current) =>
                upsertDesktopClientSession(current, toDesktopClientSessionRecord(event.payload)),
              );
              break;
            case "clientRemoved":
              setDesktopClientSessions((current) =>
                removeDesktopClientSession(current, event.payload.sessionId),
              );
              break;
          }

          setDesktopAccessManagementError(null);
          setIsLoadingDesktopAccessManagement(false);
        },
        {
          onResubscribe: () => {
            if (!cancelled) {
              setIsLoadingDesktopAccessManagement(true);
            }
          },
        },
      );
    if (desktopBridge) {
      void desktopBridge
        .getServerExposureState()
        .then((state) => {
          if (cancelled) return;
          setDesktopServerExposureState(state);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : "Failed to load network exposure state.";
          setDesktopServerExposureError(message);
        });
    } else {
      setDesktopServerExposureState(null);
      setDesktopServerExposureError(null);
    }

    return () => {
      cancelled = true;
      unsubscribeAuthAccess();
    };
  }, [canManageLocalBackend, desktopBridge]);

  useEffect(() => {
    if (canManageLocalBackend) return;
    setIsLoadingDesktopAccessManagement(false);
    setDesktopPairingLinks([]);
    setDesktopClientSessions([]);
    setDesktopAccessManagementError(null);
    setDesktopServerExposureState(null);
    setDesktopServerExposureError(null);
  }, [canManageLocalBackend]);
  const visibleDesktopPairingLinks = useMemo(
    () => desktopPairingLinks.filter((pairingLink) => pairingLink.role === "client"),
    [desktopPairingLinks],
  );
  return (
    <SettingsPageContainer>
      <HistorySyncSettingsSection />

      {canManageLocalBackend ? (
        <>
          <SettingsSection title="Manage local backend">
            {desktopBridge ? (
              <SettingsRow
                title="Network access"
                description={
                  desktopServerExposureState?.endpointUrl
                    ? `Reachable at ${desktopServerExposureState.endpointUrl}`
                    : desktopServerExposureState?.mode === "network-accessible"
                      ? desktopServerExposureState.advertisedHost
                        ? `Exposed on all interfaces. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                        : "Exposed on all interfaces."
                      : desktopServerExposureState
                        ? "Limited to this machine."
                        : "Loading…"
                }
                status={
                  desktopServerExposureError ? (
                    <span className="block text-destructive">{desktopServerExposureError}</span>
                  ) : null
                }
                control={
                  <AlertDialog
                    open={pendingDesktopServerExposureMode !== null}
                    onOpenChange={(open) => {
                      if (isUpdatingDesktopServerExposure) return;
                      if (!open) setPendingDesktopServerExposureMode(null);
                    }}
                  >
                    <Switch
                      checked={desktopServerExposureState?.mode === "network-accessible"}
                      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
                      onCheckedChange={(checked) => {
                        setPendingDesktopServerExposureMode(
                          checked ? "network-accessible" : "local-only",
                        );
                      }}
                      aria-label="Enable network access"
                    />
                    <AlertDialogPopup>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {pendingDesktopServerExposureMode === "network-accessible"
                            ? "Enable network access?"
                            : "Disable network access?"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {pendingDesktopServerExposureMode === "network-accessible"
                            ? "T3 Code will restart to expose this environment over the network."
                            : "T3 Code will restart and limit this environment back to this machine."}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogClose
                          disabled={isUpdatingDesktopServerExposure}
                          render={
                            <Button variant="outline" disabled={isUpdatingDesktopServerExposure} />
                          }
                        >
                          Cancel
                        </AlertDialogClose>
                        <Button
                          onClick={handleConfirmDesktopServerExposureChange}
                          disabled={
                            pendingDesktopServerExposureMode === null ||
                            isUpdatingDesktopServerExposure
                          }
                        >
                          {isUpdatingDesktopServerExposure ? (
                            <>
                              <Spinner className="size-3.5" />
                              Restarting…
                            </>
                          ) : pendingDesktopServerExposureMode === "network-accessible" ? (
                            "Restart and enable"
                          ) : (
                            "Restart and disable"
                          )}
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogPopup>
                  </AlertDialog>
                }
              />
            ) : (
              <SettingsRow
                title="Network access"
                description={
                  currentAuthPolicy === "remote-reachable"
                    ? "This backend is already configured for remote access. Network exposure changes must be made where the server is launched."
                    : "This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing."
                }
                control={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <Switch
                            checked={isLocalBackendNetworkAccessible}
                            disabled
                            aria-label="Enable network access"
                          />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">
                      Network exposure changes restart the backend and must be controlled where the
                      server process is launched.
                    </TooltipPopup>
                  </Tooltip>
                }
              />
            )}
          </SettingsSection>

          {isLocalBackendNetworkAccessible ? (
            <SettingsSection
              title="Authorized clients"
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              {desktopAccessManagementError ? (
                <div className={ITEM_ROW_CLASSNAME}>
                  <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
                </div>
              ) : null}
              <PairingClientsList
                endpointUrl={desktopServerExposureState?.endpointUrl}
                isLoading={isLoadingDesktopAccessManagement}
                pairingLinks={visibleDesktopPairingLinks}
                clientSessions={desktopClientSessions}
                revokingPairingLinkId={revokingDesktopPairingLinkId}
                revokingClientSessionId={revokingDesktopClientSessionId}
                onRevokePairingLink={handleRevokeDesktopPairingLink}
                onRevokeClientSession={handleRevokeDesktopClientSession}
              />
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <SettingsSection title="Local backend access">
          <SettingsRow
            title="Owner tools"
            description="Pairing links and client-session management are only available to owner sessions for this backend."
          />
        </SettingsSection>
      )}

      <SettingsSection
        title="Remote environments"
        headerAction={
          <Dialog
            open={addBackendDialogOpen}
            onOpenChange={(open) => {
              setAddBackendDialogOpen(open);
              if (!open) {
                setSavedBackendError(null);
              }
            }}
          >
            <DialogTrigger
              render={
                <Button size="xs" variant="outline">
                  <PlusIcon className="size-3" />
                  Add environment
                </Button>
              }
            />
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Add Environment</DialogTitle>
                <DialogDescription>Pair another environment to this client.</DialogDescription>
                <div className="flex gap-1 rounded-lg border border-border/60 bg-muted/50 p-1">
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      savedBackendMode === "pairing-url"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    disabled={isAddingSavedBackend}
                    onClick={() => setSavedBackendMode("pairing-url")}
                  >
                    Pairing URL
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      savedBackendMode === "host-code"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    disabled={isAddingSavedBackend}
                    onClick={() => setSavedBackendMode("host-code")}
                  >
                    Host + code
                  </button>
                </div>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  {savedBackendMode === "pairing-url" ? (
                    <p className="text-xs text-muted-foreground">
                      Enter the full pairing URL from the environment you want to connect to.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Enter the backend host and pairing code separately.
                    </p>
                  )}
                  <div className="space-y-3">
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-foreground">
                        Label
                      </span>
                      <Input
                        value={savedBackendLabel}
                        onChange={(event) => setSavedBackendLabel(event.target.value)}
                        placeholder="My backend (optional)"
                        disabled={isAddingSavedBackend}
                        spellCheck={false}
                      />
                    </label>
                    {savedBackendMode === "pairing-url" ? (
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Pairing URL
                        </span>
                        <Input
                          value={savedBackendPairingUrl}
                          onChange={(event) => setSavedBackendPairingUrl(event.target.value)}
                          placeholder="https://backend.example.com/pair#token=..."
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          The full URL including the pairing token.
                        </span>
                      </label>
                    ) : (
                      <>
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-foreground">
                            Host
                          </span>
                          <Input
                            value={savedBackendHost}
                            onChange={(event) => setSavedBackendHost(event.target.value)}
                            placeholder="https://backend.example.com"
                            disabled={isAddingSavedBackend}
                            spellCheck={false}
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-foreground">
                            Pairing code
                          </span>
                          <Input
                            value={savedBackendPairingCode}
                            onChange={(event) => setSavedBackendPairingCode(event.target.value)}
                            placeholder="Pairing code"
                            disabled={isAddingSavedBackend}
                            spellCheck={false}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  {savedBackendError ? (
                    <p className="text-xs text-destructive">{savedBackendError}</p>
                  ) : null}
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={isAddingSavedBackend}
                    onClick={() => void handleAddSavedBackend()}
                  >
                    <PlusIcon className="size-3.5" />
                    {isAddingSavedBackend ? "Adding…" : "Add Backend"}
                  </Button>
                </div>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      >
        {savedEnvironmentIds.map((environmentId) => (
          <SavedBackendListRow
            key={environmentId}
            environmentId={environmentId}
            reconnectingEnvironmentId={reconnectingSavedEnvironmentId}
            removingEnvironmentId={removingSavedEnvironmentId}
            onReconnect={handleReconnectSavedBackend}
            onRemove={handleRemoveSavedBackend}
          />
        ))}

        {savedEnvironmentIds.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              No remote environments yet. Click &ldquo;Add environment&rdquo; to pair another
              environment.
            </p>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
