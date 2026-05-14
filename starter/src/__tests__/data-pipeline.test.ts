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

  it("quarantines rows missing required clinical fields", () => {
    const result = runPipeline({
      csvText: `${HEADER}\nPT-011,NCT-001,SITE-B03,2023-07-10,,M,78.9,400mg BID,fatigue,PSA stable,stable_disease,2024-04-01,active\n`,
    });

    expect(result.clean).toEqual([]);
    expect(result.summary.totalQuarantined).toBe(1);
    expect(result.summary.totalDropped).toBe(0);
    expect(result.quarantined[0]?.reasons).toEqual(["missing_age"]);
    expect(result.summary.issuesFound.missing_age).toBe(1);
  });

  it("drops rows missing patient_id because they cannot be reconciled", () => {
    const result = runPipeline({
      csvText: `${HEADER}\n,NCT-003,SITE-D01,2024-06-01,57,F,63.5,200mg QD,headache,Lab results pending,N/A,2024-06-01,screen_fail\n`,
    });

    expect(result.clean).toEqual([]);
    expect(result.quarantined).toEqual([]);
    expect(result.summary.totalDropped).toBe(1);
    expect(result.summary.issuesFound.missing_patient_id).toBe(1);
  });

  it("accepts missing optional fields with documented defaults", () => {
    const result = runPipeline({
      csvText: `${HEADER}\nPT-048,NCT-002,SITE-H01,2021-02-01,49,M,84.2,400mg BID,,,N/A,2022-04-15,completed\n`,
    });

    expect(result.quarantined).toEqual([]);
    expect(result.clean[0]).toMatchObject({
      adverseEvents: [],
      labNotes: "",
      responseAssessment: null,
    });
  });

  it.todo("flags rows containing suspected PII in free-text fields");

  it.todo("deduplicates conflicting records for the same patient_id");
});
