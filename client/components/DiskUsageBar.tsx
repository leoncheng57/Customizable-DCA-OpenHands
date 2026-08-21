// client/components/DiskUsageBar.tsx
//
// Live disk-usage progress bar for the shared OpenHands workspace volume
// (the shared workspace volume every conversation writes into). Polls the BFF's cached
// /disk probe; best-effort — renders nothing until a reading arrives and
// disappears if the probe becomes unavailable.
import { useEffect, useState } from "react";
import { openHandsApi, type DiskUsage } from "../lib/api.js";

const POLL_MS = 30_000;
const WARN_PERCENT = 75;
const CRITICAL_PERCENT = 90;

export function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 10) return `${Math.round(gib)} GiB`;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}

export function usageTone(percent: number): "ok" | "warn" | "critical" {
  if (percent >= CRITICAL_PERCENT) return "critical";
  if (percent >= WARN_PERCENT) return "warn";
  return "ok";
}

const FILL_CLASSES: Record<ReturnType<typeof usageTone>, string> = {
  ok: "bg-[var(--color-text-success)]",
  warn: "bg-[var(--color-text-warning)]",
  critical: "bg-[var(--color-text-critical)]",
};

export function DiskUsageBar() {
  const [usage, setUsage] = useState<DiskUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      openHandsApi
        .diskUsage()
        .then((u) => {
          if (!cancelled) setUsage(u);
        })
        .catch(() => {
          if (!cancelled) setUsage(null);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!usage) return null;

  const percent = Math.min(100, Math.max(0, usage.usedPercent));
  const tone = usageTone(percent);
  return (
    <div
      className="rounded-lg border border-[var(--color-border-default)] px-4 py-3"
      data-testid="openhands-disk-usage"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">Workspace disk</span>
        <span className="text-[var(--color-text-muted)]">
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.totalBytes)} used · {percent}%
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[var(--color-background-element)]"
        role="progressbar"
        aria-label="Workspace disk usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${FILL_CLASSES[tone]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {tone !== "ok" && (
        <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          {tone === "critical"
            ? "The shared volume is nearly full — delete finished conversations or clean up old clones."
            : "The shared volume is filling up — consider deleting conversations you no longer need."}
        </p>
      )}
    </div>
  );
}
