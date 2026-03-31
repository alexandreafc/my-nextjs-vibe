"use client";

import { useEffect, useCallback, useState } from "react";

export interface ConsoleEntry {
  id: string;
  level: "log" | "warn" | "error" | "info" | "debug";
  args: string[];
  timestamp: string;
}

const MAX_ENTRIES = 500;

let consoleIdCounter = 0;

export function useConsoleCapture() {
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "console-log"
      ) {
        return;
      }

      const entry: ConsoleEntry = {
        id: `console-${++consoleIdCounter}`,
        level: event.data.level,
        args: event.data.args,
        timestamp: event.data.timestamp,
      };

      setConsoleLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const clearConsoleLogs = useCallback(() => {
    setConsoleLogs([]);
  }, []);

  return { consoleLogs, clearConsoleLogs };
}
