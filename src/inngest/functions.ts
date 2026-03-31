import { z } from "zod";
import { randomUUID } from "crypto";
import { Sandbox } from "@e2b/code-interpreter";
import { openai, createAgent, createTool, createNetwork, type Tool, type Message, createState } from "@inngest/agent-kit";

import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma";
import { redisPublisher } from "@/lib/redis";
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompt";

import { inngest } from "./client";
import { SANDBOX_TIMEOUT } from "./types";
import { getSandbox, lastAssistantTextMessageContent, parseAgentOutput } from "./utils";

interface LogEntry {
  id: string;
  source: "server" | "agent";
  level: "info" | "warn" | "error" | "debug";
  content: string;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

function publishLog(
  projectId: string,
  entry: Omit<LogEntry, "id" | "timestamp">,
  buffer: LogEntry[]
): void {
  const log: LogEntry = {
    id: randomUUID(),
    ...entry,
    timestamp: new Date().toISOString(),
  };
  buffer.push(log);
  redisPublisher
    .publish(`logs:${projectId}`, JSON.stringify(log))
    .catch(() => {});
}

interface AgentState {
  summary: string;
  files: { [path: string]: string };
  verified: boolean;
  verificationAttempts: number;
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    const logBuffer: LogEntry[] = [];

    const { sandboxId, sandboxStatus } = await step.run("get-sandbox-id", async () => {
      const project = await prisma.project.findUnique({
        where: { id: event.data.projectId },
      });

      if (project?.sandboxId) {
        const isRunning = await Sandbox.list().then((sandboxes) =>
          sandboxes.some((s) => s.sandboxId === project.sandboxId)
        );

        if (isRunning) {
          const sandbox = await getSandbox(project.sandboxId);
          await sandbox.setTimeout(SANDBOX_TIMEOUT);
          return { sandboxId: project.sandboxId, sandboxStatus: "reused" as const };
        }

        // Was stored but not running anymore
        const sandbox = await Sandbox.create("start1-nextjs-dev");
        await sandbox.setTimeout(SANDBOX_TIMEOUT);
        await prisma.project.update({
          where: { id: event.data.projectId },
          data: { sandboxId: sandbox.sandboxId },
        });
        return { sandboxId: sandbox.sandboxId, sandboxStatus: "replaced" as const };
      }

      const sandbox = await Sandbox.create("start1-nextjs-dev");
      await sandbox.setTimeout(SANDBOX_TIMEOUT);
      await prisma.project.update({
        where: { id: event.data.projectId },
        data: { sandboxId: sandbox.sandboxId },
      });
      return { sandboxId: sandbox.sandboxId, sandboxStatus: "created" as const };
    });

    const previousMessages = await step.run("get-previous-messages", async () => {
      const formattedMessages: Message[] = [];

      const messages = await prisma.message.findMany({
        where: {
          projectId: event.data.projectId,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 5,
      });

      for (const message of messages) {
        formattedMessages.push({
          type: "text",
          role: message.role === "ASSISTANT" ? "assistant" : "user",
          content: message.content,
        })
      }

      return formattedMessages.reverse();
    });

    const state = createState<AgentState>(
      {
        summary: "",
        files: {},
        verified: false,
        verificationAttempts: 0,
      },
      {
        messages: previousMessages,
      },
    );

    const terminalTool = createTool({
      name: "terminal",
      description: "Use the terminal to run commands",
      parameters: z.object({
        command: z.string(),
      }),
      handler: async ({ command }, { step }) => {
        return await step?.run("terminal", async () => {
          const buffers = { stdout: "", stderr: "" };

          try {
            const sandbox = await getSandbox(sandboxId);
            const result = await sandbox.commands.run(command, {
              timeoutMs: 0,
              onStdout: (data: string) => {
                buffers.stdout += data;
                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "info",
                  content: data,
                  metadata: { type: "cmd", cmd: command },
                }, logBuffer);
              },
              onStderr: (data: string) => {
                buffers.stderr += data;
                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "error",
                  content: data,
                  metadata: { type: "cmd", cmd: command },
                }, logBuffer);
              }
            });
            const combined = [result.stdout, buffers.stderr].filter(Boolean).join("\n");
            return combined;
          } catch (e) {
            console.error(`Command failed: ${e} \nstdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`);
            return `Command failed: ${e} \nstdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`;
          }
        });
      },
    });

    const codeAgent = createAgent<AgentState>({
      name: "code-agent",
      description: "An expert coding agent",
      system: PROMPT,
      model: openai({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultParameters: {
          temperature: 0.1,
        },
      }),
      tools: [
        terminalTool,
        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in the sandbox",
          parameters: z.object({
            files: z.array(
              z.object({
                path: z.string(),
                content: z.string(),
              }),
            ),
          }),
          handler: async (
            { files },
            { step, network }: Tool.Options<AgentState>
          ) => {
            const newFiles = await step?.run("createOrUpdateFiles", async () => {
              try {
                const updatedFiles = network.state.data.files || {};
                const sandbox = await getSandbox(sandboxId);
                for (const file of files) {
                  await sandbox.files.write(file.path, file.content);
                  updatedFiles[file.path] = file.content;
                }

                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "info",
                  content: `createOrUpdateFiles`,
                  metadata: {
                    type: "tool",
                    files: files.map((f) => f.path),
                  },
                }, logBuffer);

                return updatedFiles;
              } catch (e) {
                return "Error: " + e;
              }
            });

            if (typeof newFiles === "object") {
              network.state.data.files = newFiles;
            }
          }
        }),
        createTool({
          name: "readFiles",
          description: "Read files from the sandbox",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step }) => {
            return await step?.run("readFiles", async () => {
              try {
                const sandbox = await getSandbox(sandboxId);
                const contents = [];
                for (const file of files) {
                  const content = await sandbox.files.read(file);
                  contents.push({ path: file, content });
                }

                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "info",
                  content: `readFiles`,
                  metadata: {
                    type: "tool",
                    files,
                  },
                }, logBuffer);

                return JSON.stringify(contents);
              } catch (e) {
                return "Error: " + e;
              }
            })
          },
        })
      ],
      lifecycle: {
        onResponse: async ({ result, network }) => {
          const lastAssistantMessageText =
            lastAssistantTextMessageContent(result);

          console.log("[code-agent] onResponse - has text:", !!lastAssistantMessageText);
          console.log("[code-agent] onResponse - text (first 300 chars):", lastAssistantMessageText?.substring(0, 300) || "(empty)");
          console.log("[code-agent] onResponse - has <task_summary>:", lastAssistantMessageText?.includes("<task_summary>") || false);

          if (lastAssistantMessageText && network) {
            if (lastAssistantMessageText.includes("<task_summary>")) {
              network.state.data.summary = lastAssistantMessageText;
              console.log("[code-agent] Summary captured!");
            }
          }

          return result;
        },
      },
    });

    const verifierAgent = createAgent<AgentState>({
      name: "verifier-agent",
      description: "Verifies the dev server is running after code changes",
      system: `You are a verification agent. Your ONLY job is to check if the Next.js dev server is running.

1. Run: curl -s -w "\\n---HTTP_STATUS:%{http_code}---" http://localhost:3000 2>&1 | head -c 2000
2. If the output contains ---HTTP_STATUS:200--- → respond with exactly: VERIFICATION_OK
3. If the output contains anything else (---HTTP_STATUS:500---, connection refused, timeout) → respond with: VERIFICATION_FAILED
   followed by the FULL output you received, including any error message or stack trace from the response body.
   This error text will be used by the code agent to diagnose and fix the issue.

Do not explain. Do not fix code. Just report the result and include the full output on failure.`,
      model: openai({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultParameters: {
          temperature: 0,
        },
      }),
      tools: [terminalTool],
      lifecycle: {
        onResponse: async ({ result, network }) => {
          const content = lastAssistantTextMessageContent(result);

          console.log("[verifier] onResponse - content (first 300 chars):", content?.substring(0, 300) || "(empty)");

          if (network) {
            network.state.data.verificationAttempts += 1;

            if (content?.includes("VERIFICATION_OK")) {
              network.state.data.verified = true;
              console.log("[verifier] VERIFICATION_OK — verified = true");
            } else {
              console.log("[verifier] VERIFICATION_FAILED — clearing summary, attempt:", network.state.data.verificationAttempts);
              network.state.data.summary = "";
            }
          }

          return result;
        },
      },
    });

    const network = createNetwork<AgentState>({
      name: "coding-agent-network",
      agents: [codeAgent, verifierAgent],
      maxIter: 15,
      defaultState: state,
      router: async ({ network }) => {
        const { summary, verified, verificationAttempts } = network.state.data;

        console.log("[router] state:", { hasSummary: !!summary, verified, verificationAttempts });

        // Hard bail-out after 3 failed verification attempts
        if (!verified && verificationAttempts >= 3) {
          console.log("[router] BAIL OUT — 3 failed verification attempts");
          return;
        }

        // Summary exists but not yet verified — send to verifierAgent
        if (summary && !verified) {
          console.log("[router] → verifierAgent");
          return verifierAgent;
        }

        // Summary exists and verified — done
        if (summary && verified) {
          console.log("[router] DONE — summary + verified");
          return;
        }

        // Still working — keep routing to codeAgent
        console.log("[router] → codeAgent");
        return codeAgent;
      },
    });

    const result = await network.run(event.data.value, { state });

    publishLog(event.data.projectId, {
      source: "agent",
      level: "info",
      content: "Agent completed",
      metadata: {
        type: "lifecycle",
        verified: result.state.data.verified,
        verificationAttempts: result.state.data.verificationAttempts,
        fileCount: Object.keys(result.state.data.files || {}).length,
      },
    }, logBuffer);

    const fragmentTitleGenerator = createAgent({
      name: "fragment-title-generator",
      description: "A fragment title generator",
      system: FRAGMENT_TITLE_PROMPT,
      model: openai({
        model: process.env.OPENAI_MODEL_MINI || "gpt-4o",
        baseUrl: process.env.OPENAI_BASE_URL,
      }),
    })

    const responseGenerator = createAgent({
      name: "response-generator",
      description: "A response generator",
      system: RESPONSE_PROMPT,
      model: openai({
        model: process.env.OPENAI_MODEL_MINI || "gpt-4o",
        baseUrl: process.env.OPENAI_BASE_URL,
      }),
    });

    const { 
      output: fragmentTitleOuput
    } = await fragmentTitleGenerator.run(result.state.data.summary);
    const { 
      output: responseOutput
    } = await responseGenerator.run(result.state.data.summary);

    const hasSummary = !!result.state.data.summary;
    const fileCount = Object.keys(result.state.data.files || {}).length;
    const isVerified = result.state.data.verified;
    const verificationAttempts = result.state.data.verificationAttempts;

    console.log("[code-agent] === RESULT DIAGNOSTICS ===");
    console.log("[code-agent] hasSummary:", hasSummary);
    console.log("[code-agent] summary (first 200 chars):", result.state.data.summary?.substring(0, 200) || "(empty)");
    console.log("[code-agent] fileCount:", fileCount);
    console.log("[code-agent] files:", Object.keys(result.state.data.files || {}));
    console.log("[code-agent] isVerified:", isVerified);
    console.log("[code-agent] verificationAttempts:", verificationAttempts);

    const isError =
      !hasSummary ||
      fileCount === 0 ||
      !isVerified;

    console.log("[code-agent] isError:", isError);
    if (isError) {
      console.log("[code-agent] ERROR REASONS:", {
        noSummary: !hasSummary,
        noFiles: fileCount === 0,
        notVerified: !isVerified,
      });
    }

    const sandboxDiagnostics = await step.run("sandbox-diagnostics", async () => {
      const sandbox = await getSandbox(sandboxId);
      const diagCmd = [
        'ps aux | grep -E "next|node" | grep -v grep || echo "NO_NEXT_PROCESS"',
        'ss -tlnp 2>/dev/null | grep 3000 || echo "PORT_3000_NOT_LISTENING"',
        'curl -s -w "\\n---STATUS:%{http_code}---" http://localhost:3000 2>&1 | head -c 800',
        'tail -n 40 /tmp/nextjs-dev.log 2>/dev/null || echo "NO_LOG_FILE"',
      ].join('\necho "---"\n');

      try {
        const diag = await sandbox.commands.run(diagCmd, { timeoutMs: 15000 });
        return {
          sandboxId,
          sandboxStatus,
          agentVerified: result.state.data.verified,
          agentVerificationAttempts: result.state.data.verificationAttempts,
          agentFileCount: Object.keys(result.state.data.files || {}).length,
          agentHasSummary: !!result.state.data.summary,
          output: diag.stdout,
          stderr: diag.stderr || null,
        };
      } catch (e) {
        return {
          sandboxId,
          sandboxStatus,
          agentVerified: result.state.data.verified,
          agentVerificationAttempts: result.state.data.verificationAttempts,
          agentFileCount: Object.keys(result.state.data.files || {}).length,
          agentHasSummary: !!result.state.data.summary,
          error: String(e),
        };
      }
    });

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId);
      const host = sandbox.getHost(3000);
      return `https://${host}`;
    });

    await step.run("save-result", async () => {
      let message;

      if (isError) {
        message = await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      } else {
        message = await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: parseAgentOutput(responseOutput),
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl: sandboxUrl,
                title: parseAgentOutput(fragmentTitleOuput),
                files: result.state.data.files,
              },
            },
          },
        });
      }

      // Persist last 100 log entries
      const logsToSave = logBuffer.slice(-100);
      if (logsToSave.length > 0) {
        await prisma.log.createMany({
          data: logsToSave.map((log) => ({
            projectId: event.data.projectId,
            messageId: message.id,
            source: log.source === "server" ? "SERVER" as const : "AGENT" as const,
            level: log.level === "info" ? "INFO" as const
              : log.level === "warn" ? "WARN" as const
              : log.level === "error" ? "ERROR" as const
              : "DEBUG" as const,
            content: log.content,
            metadata: log.metadata as Prisma.InputJsonValue ?? Prisma.JsonNull,
            timestamp: new Date(log.timestamp),
          })),
        });
      }

      return message;
    });

    return {
      url: sandboxUrl,
      sandboxId,
      sandboxStatus,
      isError,
      verified: result.state.data.verified,
      verificationAttempts: result.state.data.verificationAttempts,
      fileCount: Object.keys(result.state.data.files || {}).length,
      files: Object.keys(result.state.data.files || {}),
      diagnostics: sandboxDiagnostics,
    };
  },
);
