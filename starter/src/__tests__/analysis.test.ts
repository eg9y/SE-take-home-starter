import { describe, expect, it } from "vitest";
import { getTrialSummary } from "../services/analysis-service.js";
import { getTrialById } from "../services/trial-service.js";

describe("analysis-service", () => {
	describe("getTrialSummary", () => {
		it("handles trials with a null responseRate without throwing", () => {
			const trial = getTrialById("NCT-003");
			expect(trial).toBeDefined();
			expect(trial!.responseRate).toBeNull();

			const summary = getTrialSummary(trial!);
			expect(summary.summary).toContain("Not yet available");
		});
	});
});
