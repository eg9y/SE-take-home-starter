import { describe, expect, it } from "vitest";
import { runPipeline } from "../services/data-pipeline.js";

const HEADER =
  "patient_id,trial_id,site_id,enrollment_date,age,sex,weight_kg,dose_level,adverse_events,lab_notes,response_assessment,last_visit_date,status";

describe("data-pipeline", () => {
  it("returns a well-formed PipelineResult for a header-only CSV", () => {
    const result = runPipeline({ csvText: `${HEADER}\n` });

    expect(result).toEqual({
      clean: [],
      quarantined: [],
      summary: {
        totalInput: 0,
        totalClean: 0,
        totalQuarantined: 0,
        totalDropped: 0,
        issuesFound: {},
      },
    });
  });

  it("throws when neither csvText nor csvPath is provided", () => {
    expect(() => runPipeline({})).toThrow(/csvPath or csvText/);
  });

  it("normalizes mixed date formats to ISO (YYYY-MM-DD)", () => {
    const result = runPipeline({
      csvText: `${HEADER}\nPT-001,NCT-001,SITE-A01,Jun 20 2023,67,M,82.3,400mg BID,fatigue,No findings,partial_response,2024/01/15,active\n`,
    });

    expect(result.quarantined).toEqual([]);
    expect(result.clean[0]).toMatchObject({
      enrollmentDate: "2023-06-20",
      lastVisitDate: "2024-01-15",
    });
  });

  it("quarantines rows where last visit is before enrollment", () => {
    const result = runPipeline({
      csvText: `${HEADER}\nPT-001,NCT-001,SITE-A01,2024-01-15,67,M,82.3,400mg BID,fatigue,No findings,partial_response,2023-06-20,active\n`,
    });

    expect(result.clean).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.reasons).toContain("date_inconsistency");
    expect(result.summary.issuesFound.date_inconsistency).toBe(1);
  });

  it("quarantines clinically implausible values (e.g. negative age)", () => {
    const result = runPipeline({
      csvText: `${HEADER}\nPT-001,NCT-001,SITE-A01,2023-04-12,-3,M,82.3,400mg BID,fatigue,No findings,partial_response,2024-01-15,active\n`,
    });

    expect(result.clean).toEqual([]);
    expect(result.quarantined[0]?.reasons).toContain("implausible_age");
  });

  it.todo("flags rows containing suspected PII in free-text fields");

  it.todo("deduplicates conflicting records for the same patient_id");
});
