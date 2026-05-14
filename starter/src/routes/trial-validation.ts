import { z } from "zod";

export const analyzeRequestSchema = z
	.object({
		focus: z.enum(["safety", "efficacy", "competitive"]),
	})
	.strict();

export const trialParamsSchema = z
	.object({
		id: z.string().min(1).max(128),
	})
	.strict();

export const trialQuerySchema = z
	.object({
		phase: z.enum(["I", "II", "III"]).optional(),
		status: z.enum(["recruiting", "completed", "terminated"]).optional(),
		minEnrollment: z.string().regex(/^\d+$/).transform(Number).optional(),
		sponsor: z.string().trim().min(1).optional(),
		search: z.string().trim().min(1).optional(),
		sort: z
			.enum(["startDate", "enrollment", "adverseEventRate"])
			.optional(),
		order: z.enum(["asc", "desc"]).optional(),
	})
	.strict();
