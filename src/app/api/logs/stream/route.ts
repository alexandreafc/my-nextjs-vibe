import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { createRedisSubscriber } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return new Response("Missing projectId", { status: 400 });
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
  });
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const user = await prisma.user.findUnique({
    where: { clerkId: userId },
  });
  const isAdmin = user?.isAdmin ?? false;

  const subscriber = createRedisSubscriber();
  await subscriber.connect();

  const channel = `logs:${projectId}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: string) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\nid: ${Date.now()}\ndata: ${data}\n\n`)
        );
      };

      sendEvent("connected", JSON.stringify({ projectId, isAdmin }));

      const heartbeat = setInterval(() => {
        try {
          sendEvent("heartbeat", JSON.stringify({ timestamp: new Date().toISOString() }));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      subscriber.on("message", (_channel: string, message: string) => {
        try {
          const parsed = JSON.parse(message);
          if (parsed.source === "agent" && !isAdmin) {
            return;
          }
          sendEvent("log", message);
        } catch {
          // skip malformed messages
        }
      });

      await subscriber.subscribe(channel);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
      });
    },
    cancel() {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
