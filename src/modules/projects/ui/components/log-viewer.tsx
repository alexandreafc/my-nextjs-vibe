"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface LogItem {
  id: string;
  level: string;
  content?: string;
  args?: string[];
  timestamp: string;
  metadata?: Record<string, unknown> | null;
}

interface Props {
  logs: LogItem[];
  variant?: "server" | "console" | "agent";
}

const levelColors: Record<string, string> = {
  info: "text-blue-400",
  log: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  debug: "text-muted-foreground",
};

const levelDots: Record<string, string> = {
  info: "bg-blue-400",
  log: "bg-blue-400",
  warn: "bg-yellow-400",
  error: "bg-red-400",
  debug: "bg-muted-foreground",
};

const agentBadgeColors: Record<string, string> = {
  tool: "bg-purple-500/15 text-purple-400",
  cmd: "bg-blue-500/15 text-blue-400",
  verify: "bg-yellow-500/15 text-yellow-400",
  lifecycle: "bg-green-500/15 text-green-400",
};

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function LogViewer({ logs, variant = "server" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldAutoScroll.current) return;
    container.scrollTop = container.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  if (logs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No logs yet...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-2 font-mono text-xs leading-relaxed"
    >
      {logs.map((log) => (
        <div key={log.id} className="flex gap-2 py-0.5 hover:bg-muted/30">
          <span className="text-muted-foreground shrink-0">
            {formatTime(log.timestamp)}
          </span>

          {variant === "agent" && !!(log.metadata?.type) && (
            <span
              className={cn(
                "shrink-0 rounded px-1 text-[10px] font-medium uppercase",
                agentBadgeColors[log.metadata.type as string] ??
                  "bg-muted text-muted-foreground"
              )}
            >
              {log.metadata.type as string}
            </span>
          )}

          {variant !== "agent" && (
            <span
              className={cn(
                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                levelDots[log.level] ?? levelDots.info
              )}
            />
          )}

          <span
            className={cn(
              "break-all",
              variant === "agent"
                ? "text-muted-foreground"
                : levelColors[log.level] ?? "text-muted-foreground"
            )}
          >
            {log.content ?? log.args?.join(" ") ?? ""}
          </span>

          {variant === "agent" && !!(log.metadata?.files) && (
            <span className="text-muted-foreground text-[10px]">
              {(log.metadata.files as string[]).join(", ")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
