"use client";

import { useEffect, useRef, useCallback, useState } from "react";

export interface LogEntry {
  id: string;
  source: "server" | "agent";
  level: "info" | "warn" | "error" | "debug";
  content: string;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

const MAX_LOGS = 1000;

export function useLogStream(projectId: string) {
  const [serverLogs, setServerLogs] = useState<LogEntry[]>([]);
  const [agentLogs, setAgentLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const es = new EventSource(`/api/logs/stream?projectId=${projectId}`);
    eventSourceRef.current = es;

    es.addEventListener("connected", (e) => {
      const data = JSON.parse(e.data);
      setIsConnected(true);
      setIsAdmin(data.isAdmin);
    });

    es.addEventListener("log", (e) => {
      const entry: LogEntry = JSON.parse(e.data);

      if (entry.source === "server") {
        setServerLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
      } else {
        setAgentLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
      }
    });

    es.addEventListener("heartbeat", () => {
      setIsConnected(true);
    });

    es.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    };
  }, [projectId]);

  const clearLogs = useCallback(() => {
    setServerLogs([]);
    setAgentLogs([]);
  }, []);

  return { serverLogs, agentLogs, isConnected, isAdmin, clearLogs };
}
