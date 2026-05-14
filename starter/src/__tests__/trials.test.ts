import { describe, expect, it, vi } from "vitest";
import { getTrialById, listTrials } from "../services/trial-service.js";

vi.mock("ai", () => ({
	streamText: vi.fn(() => ({
		textStream: (async function* () {
			yield "analysis";
		})(),
	})),
}));

vi.mock("@ai-sdk/openai", () => ({
	openai: vi.fn(() => "mock-model"),
}));

const express = (await import("express")).default;
const { trialsRouter } = await import("../routes/trials.js");

describe("trial-service", () => {
	describe("getTrialById", () => {
		it("returns a trial for a valid ID", () => {
			const trial = getTrialById("NCT-001");
			expect(trial).toBeDefined();
			expect(trial!.name).toBe("AURORA-1: Pocenbrodib in mCRPC");
		});

		it("returns undefined for an invalid ID", () => {
			const trial = getTrialById("NCT-999");
			expect(trial).toBeUndefined();
		});
	});

	describe("listTrials", () => {
		it("returns all trials when no filters are applied", () => {
			const result = listTrials({});
			expect(result.trials.length).toBeGreaterThan(0);
			expect(result.total).toBe(result.trials.length);
		});

		it("filters by phase", () => {
			const result = listTrials({ phase: "III" });
			expect(result.trials.every((t) => t.phase === "III")).toBe(true);
		});

		it("filters by status", () => {
			const result = listTrials({ status: "completed" });
			expect(result.trials.every((t) => t.status === "completed")).toBe(true);
		});

		it("filters by minEnrollment", () => {
			const result = listTrials({ minEnrollment: 400 });
			expect(result.trials.every((t) => t.enrollment >= 400)).toBe(true);
			expect(result.trials.length).toBeGreaterThan(0);
		});

		it("sorts by startDate", () => {
			const result = listTrials({ sort: "startDate" });
			const dates = result.trials.map((t) => new Date(t.startDate).getTime());
			for (let i = 1; i < dates.length; i++) {
				expect(dates[i]! <= dates[i - 1]!).toBe(true);
			}
		});

		it("sorts by enrollment ascending", () => {
			const result = listTrials({ sort: "enrollment", order: "asc" });
			const enrollments = result.trials.map((t) => t.enrollment);
			for (let i = 1; i < enrollments.length; i++) {
				expect(enrollments[i]! >= enrollments[i - 1]!).toBe(true);
			}
		});
	});
});

describe("trials routes", () => {
	it("rejects invalid analysis focus values", async () => {
		const testApp = express();
		testApp.use(express.json());
		testApp.use("/trials", trialsRouter);

		const server = testApp.listen(0);

		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("Expected test server to listen on a random port");
			}

			const response = await fetch(
				`http://127.0.0.1:${address.port}/trials/NCT-001/analyze`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ focus: "not-real" }),
				},
			);

			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toEqual({
				error: "Invalid focus",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
