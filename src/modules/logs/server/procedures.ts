import { z } from "zod";

import { prisma } from "@/lib/db";
import { protectedProcedure, createTRPCRouter } from "@/trpc/init";

export const logsRouter = createTRPCRouter({
  getByProject: protectedProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        limit: z.number().min(1).max(200).default(100),
      })
    )
    .query(async ({ input, ctx }) => {
      const logs = await prisma.log.findMany({
        where: {
          projectId: input.projectId,
          project: {
            userId: ctx.auth.userId,
          },
        },
        orderBy: {
          timestamp: "asc",
        },
        take: input.limit,
      });

      return logs;
    }),
});
