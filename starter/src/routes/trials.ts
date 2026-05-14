import type { Request, Response } from "express";
import { Router } from "express";
import {
	getTrialSummary,
	streamAnalysis,
} from "../services/analysis-service.js";
import { getTrialById, listTrials } from "../services/trial-service.js";
import type { ClinicalTrial, ErrorResponse, TrialListResponse } from "../types.js";
import {
	analyzeRequestSchema,
	trialParamsSchema,
	trialQuerySchema,
} from "./trial-validation.js";

const router = Router();

router.get(
	"/",
	(req: Request, res: Response<TrialListResponse | ErrorResponse>) => {
		const parsedQuery = trialQuerySchema.safeParse(req.query);
		if (!parsedQuery.success) {
			res.status(400).json({ error: "Invalid trial query" });
			return;
		}

		const query = parsedQuery.data;
		const filters: Parameters<typeof listTrials>[0] = {};

		if (query.phase !== undefined) filters.phase = query.phase;
		if (query.status !== undefined) filters.status = query.status;
		if (query.minEnrollment !== undefined) {
			filters.minEnrollment = query.minEnrollment;
		}
		if (query.sponsor !== undefined) filters.sponsor = query.sponsor;
		if (query.search !== undefined) filters.search = query.search;
		if (query.sort !== undefined) filters.sort = query.sort;
		if (query.order !== undefined) filters.order = query.order;

		const result = listTrials(filters);

		res.json(result);
	},
);

router.get(
	"/:id",
	(req: Request<{ id: string }>, res: Response<ClinicalTrial | ErrorResponse>) => {
		const parsedParams = trialParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(400).json({ error: "Invalid trial id" });
			return;
		}

		const trial = getTrialById(parsedParams.data.id);
		if (!trial) {
			res.status(404).json({ error: "Trial not found" });
			return;
		}
		res.json(trial);
	},
);

router.get(
	"/:id/summary",
	(req: Request<{ id: string }>, res: Response) => {
		const parsedParams = trialParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(400).json({ error: "Invalid trial id" });
			return;
		}

		const trial = getTrialById(parsedParams.data.id);
		if (!trial) {
			res.status(404).json({ error: "Trial not found" });
			return;
		}

		const summary = getTrialSummary(trial);
		res.json(summary);
	},
);

router.post(
	"/:id/analyze",
	async (
		req: Request<{ id: string }, ErrorResponse, unknown>,
		res: Response<ErrorResponse>,
	) => {
		const parsedParams = trialParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(400).json({ error: "Invalid trial id" });
			return;
		}

		const trial = getTrialById(parsedParams.data.id);
		if (!trial) {
			res.status(404).json({ error: "Trial not found" });
			return;
		}

		const parsedBody = analyzeRequestSchema.safeParse(req.body);
		if (!parsedBody.success) {
			res.status(400).json({ error: "Invalid focus" });
			return;
		}

		try {
			await streamAnalysis(trial, parsedBody.data.focus, res);
		} catch (err) {
			if (!res.headersSent) {
				res.status(500).json({
					error: err instanceof Error ? err.message : "Analysis failed",
				});
			}
		}
	},
);

export { router as trialsRouter };
