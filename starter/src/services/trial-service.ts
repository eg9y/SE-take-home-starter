import { trials as trialData } from "../data.js";
import type { ClinicalTrial } from "../types.js";

interface TrialFilters {
	phase?: string;
	status?: string;
	minEnrollment?: number;
	sponsor?: string;
	search?: string;
	sort?: string;
	order?: string;
}

const trialCache = new Map<string, ClinicalTrial>();

function buildCache(): void {
	for (const trial of trialData) {
		trialCache.set(trial.id, trial);
	}
}

buildCache();

export function getTrialById(id: string): ClinicalTrial | undefined {
	const trial = trialCache.get(id);
	return trial ? structuredClone(trial) : undefined;
}

export function listTrials(filters: TrialFilters): {
	trials: ClinicalTrial[];
	total: number;
} {
	let results = [...trialData];

	if (filters.phase) {
		results = results.filter((t) => t.phase === filters.phase);
	}

	if (filters.status) {
		results = results.filter((t) => t.status === filters.status);
	}

	if (filters.minEnrollment) {
		results = results.filter((t) => t.enrollment >= filters.minEnrollment!);
	}

	if (filters.sponsor) {
		results = results.filter((t) =>
			t.sponsor.toLowerCase().includes(filters.sponsor!.toLowerCase()),
		);
	}

	if (filters.search) {
		const query = filters.search.toLowerCase();
		const scored = results
			.map((t) => {
				let score = 0;
				if (t.name.toLowerCase().includes(query)) score += 3;
				if (t.indication.toLowerCase().includes(query)) score += 2;
				if (t.primaryEndpoint.toLowerCase().includes(query)) score += 1;
				if (
					t.keyFindings.some((finding) =>
						finding.toLowerCase().includes(query),
					)
				)
					score += 2;
				return { trial: t, score };
			})
			.filter(({ score }) => score > 0);

		results = scored.map(({ trial }) => trial);
	}

	const sortField = filters.sort ?? "startDate";
	const sortOrder = filters.order ?? "desc";

	results.sort((a, b) => {
		let cmp: number;
		switch (sortField) {
			case "enrollment":
				cmp = a.enrollment - b.enrollment;
				break;
			case "startDate":
				cmp = new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
				break;
			case "adverseEventRate":
				cmp = a.adverseEventRate - b.adverseEventRate;
				break;
			default:
				cmp = 0;
		}
		return sortOrder === "asc" ? cmp : -cmp;
	});

	return {
		trials: results.map((t) => structuredClone(t)),
		total: results.length,
	};
}
