import { z } from "zod";

export const analyzeRequestSchema = z
	.object({
		focus: z.enum(["safety", "efficacy", "competitive"]),
	})
	.strict();
