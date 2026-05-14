# Data Pipeline Decisions

## Use case

I am treating this pipeline as an ingestion step for an internal Pathos clinical
 product: dashboards, search, and AI-assisted summaries over
patient-level oncology trial data.

The cleaned output should be useful for analysis, but it is not the regulatory
source of truth and should not silently override the CRO record. When a value
is clinically meaningful and questionable, the safer default is to quarantine it
for human review rather than guess.

## Downstream assumptions

I assume downstream consumers need:

- Consistent, typed records for analytics and API use.
- High precision for clinical fields such as age, weight, dose, dates, status,
  adverse events, and response assessment.
- Conservative handling of questionable clinical data.
- Privacy hygiene before free text is exposed to search, dashboards, or AI
  prompts.
- Traceability: every cleaned, quarantined, or dropped row should have a clear
  reason.

## Pipeline contract

- **Input:** path to a CSV file or raw CSV text.
- **Output:** a `PipelineResult` containing:
  - `clean` — validated, normalized patient records.
  - `quarantined` — rows that need human review, with the raw source row and
    reason codes.
  - `summary` — counts of input, clean, quarantined, dropped, and issue types.

For error reporting, I want the JSON to be stable enough for dashboards and data
operations workflows, not just human-readable logs:

```ts
{
  clean: PatientRecord[];
  quarantined: Array<{
    record: Record<string, string>; // raw source row for traceability
    reasons: string[];              // stable, machine-countable reason codes
  }>;
  summary: {
    totalInput: number;
    totalClean: number;
    totalQuarantined: number;
    totalDropped: number;
    issuesFound: Record<string, number>;
  };
}
```

Reason strings should be treated as stable codes, for example
`missing_patient_id`, `ambiguous_date`, `implausible_weight`,
`suspected_pii`, `conflicting_duplicate`, or `structural_null_row`. In a
production version I would likely expand these into objects with `{ code,
field, message, severity }`, but for this exercise a string code plus the raw
row keeps the API simple and testable.

The pipeline has three row dispositions:

1. **Accept** — the row is valid, or only required mechanical normalization.
2. **Quarantine** — the row may be recoverable, but needs human review.
3. **Drop** — the row is not usable enough to review productively.

## Planned decisions by issue type

### 1. Mixed date formats

**Decision:** Normalize recognized, unambiguous dates to ISO `YYYY-MM-DD`.

The source file contains formats such as `2023-04-12`, `04/25/2023`,
`Jun 20 2023`, `2023/11/01`, and `15/05/2024`. These are mechanical formatting
issues when the date is clear, so the pipeline should standardize them.

The pipeline should quarantine dates that are invalid or ambiguous. It should
also quarantine rows where `last_visit_date` is before `enrollment_date`, because
that would affect follow-up and trial-status analysis.

**Alternatives considered:**

- Accept dates as strings. Keeps the source unchanged but makes downstream
  filtering and analytics fragile.
- Let JavaScript parse dates freely. Risky because ambiguous date strings
  can be interpreted differently across formats and environments.

### 2. Missing required fields

**Decision:** Treat core identifiers and clinical fields as required.

Required fields should include `patient_id`, `trial_id`, `site_id`,
`enrollment_date`, `age`, `sex`, `weight_kg`, `dose_level`, `last_visit_date`,
and `status`.

A row missing `patient_id` should be dropped, because there is no stable subject
key to reconcile. In this dataset, the blank-subject row after `PT-028` is best
classified as a structural null/header-artifact-style feed defect rather than a
clinical adjudication failure: it should be counted under drops with a stable
reason such as `missing_patient_id` or `structural_null_row`, not silently mixed
into ordinary quarantined clinical records. Rows missing other required fields
should be quarantined.

Blank `adverse_events` can be normalized to an empty list. Blank `lab_notes` can
be accepted as an empty string. `response_assessment` values such as `N/A` can be
normalized to `null`, especially for screen failures or early withdrawals.

**Alternatives considered:**

- Impute missing clinical values. I rejected this because age, weight, dose,
  dates, and status are clinically meaningful.
- Drop every row with any missing field. This is too strict for real CRO data,
  where some optional fields may be legitimately empty.

### 3. Clinically implausible values

**Decision:** Quarantine implausible clinical values instead of correcting them.

Examples in the file include negative age, age `155`, and weight `0`. These are
syntactically valid numbers but clinically implausible for this use case.

The pipeline should use conservative adult oncology bounds, such as age `18–120`
and weight `30–250 kg`. Values outside those ranges should be quarantined.

The pipeline can normalize harmless categorical variants, such as `Male` to `M`,
when the meaning is clear.

**Alternatives considered:**

- Clamp values into range or impute from trial averages. I rejected this because
  it would create false clinical facts.
- Validate trial-specific eligibility, such as whether a patient belongs in a
  prostate cancer trial. I would only do this with protocol metadata. Without
  that metadata, the pipeline should perform general plausibility checks, not
  protocol adjudication. For example, `PT-006` is a female subject in `NCT-001`,
  and the lab notes imply a prostate cancer context. That is suspicious, but I
  would not auto-drop it from this file alone. If protocol metadata says
  `NCT-001` is male-only, this should become a protocol/eligibility violation
  quarantine reason.

### 4. Dose and treatment normalization

**Decision:** Preserve dose/treatment strings, while flagging non-standard or
non-numeric dosing for future schema-level normalization.

The file contains conventional dose strings such as `400mg BID`, escalation
cohorts such as `200mg BID` and `50mg QD`, and treatment-arm descriptions such
as `vemurafenib + cobimetinib` or `vemurafenib monotherapy`. For the current
`PatientRecord` schema, `doseLevel` is a string, so the pipeline should not force
these into a single numeric field and lose regimen information.

However, downstream analytics may eventually need structured dose fields such as
`doseAmount`, `doseUnit`, `frequency`, `drugNames`, and `combinationArm`. I would
therefore normalize whitespace and encoding in `dose_level`, accept known
regimen strings as valid labels, and count/flag values that cannot be parsed as a
simple numeric dose under a reason such as `non_numeric_dose_level` if dose-based
analytics require it. I would not quarantine combination therapies solely because
they are non-numeric; they may be valid treatment arms.

**Alternatives considered:**

- Parse every dose into a number. This fails for combination regimens and would
  conflate dose level with treatment arm.
- Quarantine all non-numeric doses. This is too strict because records such as
  `PT-041` appear to represent a valid melanoma combination therapy arm.
- Leave the field entirely unexamined. This keeps ingestion simple but hides a
  predictable downstream analytics limitation.

### 5. Suspected PII in free-text fields

**Decision:** Quarantine rows with suspected PII in free text.

The `lab_notes` field contains possible patient names, MRNs, emails, SSN-like
values, and staff names. Because this data may flow into search, dashboards, or
AI prompts, suspected PII should not pass into the clean dataset by default.

This is not just a regex problem. SSN-like strings and emails are relatively easy
to catch, but contextual PHI/PII such as `Patient John Williams`, `Dr. Rachel
Kim`, or `CRA Lisa Park` is harder: staff names may be operationally useful to a
clinical reviewer, while patient names are almost never appropriate for the
analytics/AI use case. My default for this exercise is conservative quarantine
for any personal names or contact information in free text. In production, I
would separate staff/contact workflow metadata from clinical notes and apply a
reviewed redaction policy before exposing text to search or AI prompts.

In production, I would prefer a redaction workflow plus human review. For this
exercise, quarantine is the safer and clearer behavior.

**Alternatives considered:**

- Redact automatically and accept the row. This is attractive, but false
  negatives are dangerous and the regexes would need careful review.
- Accept staff names or emails as harmless. I rejected this for the initial
  pipeline because free-text personal data is unnecessary for the intended
  analytics use case.

### 6. Duplicate records with conflicting data

**Decision:** Automatically deduplicate exact duplicates, but quarantine
conflicting duplicate patient records.

The file contains duplicate `patient_id` values with conflicting clinical data.
For example, `PT-003` appears twice with different response information and visit
dates. That may represent a later update, but the file does not provide a source
update timestamp or clear version marker.

If duplicates are identical after normalization, the pipeline can keep one copy.
If duplicates conflict on clinical fields, the group should be quarantined for
review rather than silently choosing one row.

**Identity definition (what counts as "the same record").**

The pipeline compares duplicates by an explicit fingerprint over a curated
subset of fields rather than the entire normalized record. The fingerprint
includes: `trialId`, `siteId`, `enrollmentDate`, `age`, `sex`, `weight`,
`doseLevel`, sorted `adverseEvents`, `responseAssessment`, `lastVisitDate`, and
`status`. It deliberately **excludes `labNotes`**.

`labNotes` is append-only narrative commentary. Two rows for the same patient
that differ only in lab notes (e.g. one with "Initial review" and one with
"Reviewed by oncologist") represent the same clinical reality, not a conflict.
Including lab notes in identity would cause spurious `conflicting_duplicate`
quarantines on every benign re-export of the source file. Any clinically
meaningful disagreement (response assessment, visit date, status, dose, AEs,
etc.) still triggers a conflict.

When two rows for the same patient match the fingerprint, the first row is
kept and an `exact_duplicate` issue is counted. When they don't match, every
row in the conflict group is quarantined as `conflicting_duplicate` so that
reviewers can see the full set side-by-side. This matches the behavior of
`PT-003` in the source file, where the two rows disagree on
`response_assessment` and `last_visit_date`.

**Alternatives considered:**

- Use the entire normalized record as the identity key (e.g. `JSON.stringify`).
  Simpler to write, but conflates narrative drift in `labNotes` with real
  clinical conflict, and silently breaks if the schema later gains a field
  whose serialization is order- or formatting-sensitive.
- Keep the row with the latest `last_visit_date`. This may be reasonable if the
  feed is known to be append-only updates, but that assumption is not documented.
- Keep the last row in the file. This is simple but too implicit for clinical
  data.

### 7. Encoding artifacts

**Decision:** Don't normalize encoding artifacts. Preserve text as received.

I inspected the source file before writing code for this. The only non-ASCII
characters in `incoming_patient_data.csv` are 12 em dashes (U+2014), all inside
`lab_notes`, e.g. `"PSA 22.7 ng/mL, slight increase \u2014 consider dose
adjustment"`. There are no BOMs, smart quotes, replacement characters
(U+FFFD), control characters, or mojibake. The file is clean UTF-8.

Given that, the layered defaults already in place are sufficient:

- `csv-parse` is configured with `bom: true`, so a BOM-prefixed file would be
  stripped at the parser boundary before any field reaches `normalizeRow`.
- Per-field `.trim()` handles ASCII whitespace as well as NBSP and other
  Unicode whitespace that can sneak in via copy-paste from Word/Excel.
- Em dashes are valid UTF-8 typography, not corruption. They round-trip
  through JSON, search, and AI prompts without issue, and rewriting them to
  ASCII (`-` or `--`) is a lossy cosmetic change that would silently break
  any future code that does string equality against the source.

**Alternatives considered:**

- Add speculative detection for U+FFFD, lone surrogates, and non-printable
  control characters and quarantine rows that contain them. I considered this
  and rejected it: zero rows in the source file require it, so the validator
  would ship completely untested against real data, and defensive code that
  never fires tends to rot. The right time to add it is when an actual
  corrupted feed appears, with a concrete example to write a test against.
- ASCII-fy text (em dash \u2014 `--`, smart quotes \u2014 straight quotes,
  etc.). Rejected because the file does not contain anything that needs it,
  and rewriting valid Unicode is destructive.
- Treat encoding hygiene as a row-level concern in this pipeline. If future
  feeds do introduce mojibake, the better place to catch it is at the
  source-encoding boundary (file read or HTTP response, where the byte stream
  is still available), not row-by-row inside `normalizeRow` after the parser
  has already produced strings.

## Open questions

Before shipping this to production, I would confirm:

- Which fields are contractually required by the CRO feed.
- The expected date formats and locale rules.
- Whether duplicate rows represent updates, corrections, or true data errors.
- Whether source update timestamps are available.
- Which free-text fields are allowed to contain site staff names or contact
  information.
- Whether Pathos wants automatic PII redaction, quarantine-only handling, or both.
- Whether protocol-specific eligibility checks should be included once protocol
  metadata is available.
- Whether dose/treatment analytics require a structured regimen schema beyond
  the current `doseLevel` string.
