"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilterIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import { LogViewer } from "./log-viewer";
import { useLogStream, type LogEntry } from "@/hooks/use-log-stream";
import {
  useConsoleCapture,
  type ConsoleEntry,
} from "@/hooks/use-console-capture";

interface Props {
  projectId: string;
}

function filterLogs<T extends { content?: string; args?: string[]; level: string }>(
  logs: T[],
  filter: string
): T[] {
  if (!filter) return logs;
  const lower = filter.toLowerCase();
  return logs.filter((log) => {
    const text = log.content ?? log.args?.join(" ") ?? "";
    return text.toLowerCase().includes(lower) || log.level.includes(lower);
  });
}

function StatusBar({
  isConnected,
  count,
  filter,
  onFilterChange,
  onClear,
}: {
  isConnected: boolean;
  count: number;
  filter: string;
  onFilterChange: (v: string) => void;
  onClear: () => void;
}) {
  const [showFilter, setShowFilter] = useState(false);

  return (
    <div className="flex items-center gap-2 border-t px-2 py-1 text-[10px]">
      <span
        className={cn(
          "flex items-center gap-1",
          isConnected ? "text-green-500" : "text-muted-foreground"
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isConnected ? "bg-green-500" : "bg-muted-foreground"
          )}
        />
        {isConnected ? "Live" : "Disconnected"}
      </span>
      <span className="text-muted-foreground">{count} entries</span>
      <div className="ml-auto flex items-center gap-1">
        {showFilter && (
          <Input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter..."
            className="h-5 w-32 text-[10px] px-1"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={() => setShowFilter(!showFilter)}
        >
          <FilterIcon className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onClear}
        >
          <Trash2Icon className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export function LogsPanel({ projectId }: Props) {
  const trpc = useTRPC();
  const { serverLogs, agentLogs, isConnected, isAdmin, clearLogs } =
    useLogStream(projectId);
  const { consoleLogs, clearConsoleLogs } = useConsoleCapture();
  const { data: historicalLogs } = useQuery(
    trpc.logs.getByProject.queryOptions({ projectId })
  );

  // Merge historical logs (from DB) with live logs (from SSE)
  const mergedServerLogs = useMemo(() => {
    const historical = (historicalLogs ?? [])
      .filter((l) => l.source === "SERVER")
      .map((l) => ({
        id: l.id,
        source: "server" as const,
        level: l.level.toLowerCase() as LogEntry["level"],
        content: l.content,
        metadata: l.metadata as Record<string, unknown> | null,
        timestamp: new Date(l.timestamp).toISOString(),
      }));
    return [...historical, ...serverLogs];
  }, [historicalLogs, serverLogs]);

  const mergedAgentLogs = useMemo(() => {
    const historical = (historicalLogs ?? [])
      .filter((l) => l.source === "AGENT")
      .map((l) => ({
        id: l.id,
        source: "agent" as const,
        level: l.level.toLowerCase() as LogEntry["level"],
        content: l.content,
        metadata: l.metadata as Record<string, unknown> | null,
        timestamp: new Date(l.timestamp).toISOString(),
      }));
    return [...historical, ...agentLogs];
  }, [historicalLogs, agentLogs]);

  const [serverFilter, setServerFilter] = useState("");
  const [consoleFilter, setConsoleFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");

  const filteredServerLogs = filterLogs(mergedServerLogs, serverFilter);
  const filteredConsoleLogs = filterLogs(consoleLogs, consoleFilter);
  const filteredAgentLogs = filterLogs(mergedAgentLogs, agentFilter);

  const leftPanel = (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="server" className="flex h-full flex-col gap-0">
        <TabsList className="h-8 w-full justify-start rounded-none border-b bg-transparent p-0 px-2">
          <TabsTrigger
            value="server"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Server
          </TabsTrigger>
          <TabsTrigger
            value="console"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Console
          </TabsTrigger>
        </TabsList>
        <TabsContent value="server" className="flex-1 flex flex-col mt-0 min-h-0">
          <LogViewer logs={filteredServerLogs} variant="server" />
          <StatusBar
            isConnected={isConnected}
            count={filteredServerLogs.length}
            filter={serverFilter}
            onFilterChange={setServerFilter}
            onClear={clearLogs}
          />
        </TabsContent>
        <TabsContent value="console" className="flex-1 flex flex-col mt-0 min-h-0">
          <LogViewer logs={filteredConsoleLogs} variant="console" />
          <StatusBar
            isConnected={true}
            count={filteredConsoleLogs.length}
            filter={consoleFilter}
            onFilterChange={setConsoleFilter}
            onClear={clearConsoleLogs}
          />
        </TabsContent>
      </Tabs>
    </div>
  );

  if (!isAdmin) {
    return <div className="h-full flex flex-col">{leftPanel}</div>;
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      <ResizablePanel defaultSize={62} minSize={30}>
        {leftPanel}
      </ResizablePanel>
      <ResizableHandle className="hover:bg-primary transition-colors" />
      <ResizablePanel defaultSize={38} minSize={20}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <span className="text-sm font-semibold text-purple-400">
              Agent Logs
            </span>
            <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-medium text-purple-400">
              ADMIN
            </span>
          </div>
          <LogViewer logs={filteredAgentLogs} variant="agent" />
          <StatusBar
            isConnected={isConnected}
            count={filteredAgentLogs.length}
            filter={agentFilter}
            onFilterChange={setAgentFilter}
            onClear={clearLogs}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
