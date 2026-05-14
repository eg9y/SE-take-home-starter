import { describe, expect, it } from "vitest";
import {
	buildPromptForTest,
	getTrialSummary,
	PromptValidationError,
} from "../services/analysis-service.js";
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

	describe("buildPrompt size bounds", () => {
		it("accepts a normal trial", () => {
			const trial = getTrialById("NCT-001")!;
			expect(() => buildPromptForTest(trial, "safety")).not.toThrow();
		});

		it("rejects a trial with an oversized id", () => {
			const trial = { ...getTrialById("NCT-001")!, id: "x".repeat(100_000) };
			expect(() => buildPromptForTest(trial, "safety")).toThrow(
				PromptValidationError,
			);
		});

		it("rejects a trial with too many keyFindings entries", () => {
			const trial = {
				...getTrialById("NCT-001")!,
				keyFindings: Array.from({ length: 50 }, (_, i) => `finding ${i}`),
			};
			expect(() => buildPromptForTest(trial, "safety")).toThrow(
				PromptValidationError,
			);
		});
	});
});
