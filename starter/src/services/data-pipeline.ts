import { readFileSync } from "node:fs";
import { parse as parseCsvSync } from "csv-parse/sync";
import type { PatientRecord, PipelineResult } from "../types.js";

export interface PipelineOptions {
	/** Path to a CSV file. Either `csvPath` or `csvText` must be provided. */
	csvPath?: string;
	/** Raw CSV text. Useful for testing. */
	csvText?: string;
}

type RawRow = Record<string, string>;

/**
 * Per-patient bookkeeping built up in a single pass over the input.
 *
 * `record` / `raw` / `warnings` are the first occurrence of this patient. We
 * keep the raw row so that conflict quarantines retain source-row traceability.
 *
 * `fingerprint` identifies the first record's clinical identity (see
 * `recordFingerprint`). Subsequent rows for the same `patientId` are compared
 * against this fingerprint:
 *   - same fingerprint -> increment `duplicates` (resolved as `exact_duplicate`)
 *   - different fingerprint -> push the raw row into `conflictingRaws`
 *     (resolved as `conflicting_duplicate` for every row in the group,
 *     including the first one).
 */
type PatientEntry = {
	record: PatientRecord;
	raw: RawRow;
	warnings: string[];
	fingerprint: string;
	duplicates: number;
	conflictingRaws: RawRow[];
};

const REQUIRED_FIELDS = [
	"patient_id",
	"trial_id",
	"site_id",
	"enrollment_date",
	"age",
	"sex",
	"weight_kg",
	"dose_level",
	"last_visit_date",
	"status",
] as const;

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

function value(row: RawRow, field: string): string {
	return (row[field] ?? "").trim();
}

function toIsoDate(year: number, month: number, day: number): string | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}

	return `${year.toString().padStart(4, "0")}-${month
		.toString()
		.padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDate(
	input: string,
): { ok: true; iso: string } | { ok: false; reason: string } {
	const text = input.trim();

	const yearFirst = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
	if (yearFirst !== null) {
		const iso = toIsoDate(
			Number(yearFirst[1]),
			Number(yearFirst[2]),
			Number(yearFirst[3]),
		);
		return iso === null
			? { ok: false, reason: "invalid_date" }
			: { ok: true, iso };
	}

	const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
	if (slash !== null) {
		const first = Number(slash[1]);
		const second = Number(slash[2]);
		const year = Number(slash[3]);

		if (first <= 12 && second <= 12) {
			return { ok: false, reason: "ambiguous_date" };
		}

		const month = first > 12 ? second : first;
		const day = first > 12 ? first : second;
		const iso = toIsoDate(year, month, day);
		return iso === null
			? { ok: false, reason: "invalid_date" }
			: { ok: true, iso };
	}

	const monthName = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
	if (monthName !== null) {
		const month = MONTHS[monthName[1]?.toLowerCase() ?? ""];
		if (month === undefined) {
			return { ok: false, reason: "invalid_date" };
		}
		const iso = toIsoDate(Number(monthName[3]), month, Number(monthName[2]));
		return iso === null
			? { ok: false, reason: "invalid_date" }
			: { ok: true, iso };
	}

	return { ok: false, reason: "invalid_date" };
}

function parseSex(input: string): PatientRecord["sex"] | null {
	const normalized = input.trim().toLowerCase();
	if (normalized === "m" || normalized === "male") return "M";
	if (normalized === "f" || normalized === "female") return "F";
	if (normalized === "other") return "Other";
	return null;
}

function parseStatus(input: string): PatientRecord["status"] | null {
	if (["active", "completed", "withdrawn", "screen_fail"].includes(input)) {
		return input as PatientRecord["status"];
	}
	return null;
}

function parseResponse(input: string): string | null {
	const normalized = input.trim();
	return normalized === "" || normalized.toLowerCase() === "n/a"
		? null
		: normalized;
}

function parseAdverseEvents(input: string): string[] {
	return input
		.split(";")
		.map((event) => event.trim())
		.filter((event) => event.length > 0);
}

function normalizeDoseLevel(input: string): {
	value: string;
	warnings: string[];
} {
	const normalized = input.replace(/\s+/g, " ").trim();
	const simpleDose =
		/^\d+(?:\.\d+)?\s*(?:mg|mcg|g)(?:\s+(?:qd|bid|tid|qid))?$/i;

	return {
		value: normalized,
		warnings: simpleDose.test(normalized) ? [] : ["non_numeric_dose_level"],
	};
}

function containsSuspectedPii(input: string): boolean {
	return [
		/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
		/\bMRN\s*:?\s*\w+/i,
		/\bSSN\b|\b\d{3}-\w{2}-\d{4}\b/i,
		/\b(?:patient|dr\.?|cra|contact)\s*:?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)+\b/i,
	].some((pattern) => pattern.test(input));
}

/**
 * Parse a CSV string into rows keyed by header name.
 *
 * We use `csv-parse` (RFC 4180-compliant) rather than hand-rolling: real CSV
 * has quoted fields, embedded commas/newlines, and BOM/encoding artifacts
 * that are easy to get subtly wrong. All values are returned as strings;
 * type coercion and validation happen in `normalizeRow`.
 */
function parseCsv(text: string): { rows: RawRow[] } {
	const rows = parseCsvSync(text, {
		columns: true,
		skip_empty_lines: true,
		trim: true,
		bom: true,
	}) as RawRow[];
	return { rows };
}

/**
 * Normalize a single raw row into a `PatientRecord`, or return the reasons
 * why it should be quarantined / dropped.
 */
function normalizeRow(
	raw: RawRow,
):
	| { ok: true; record: PatientRecord; warnings: string[] }
	| { ok: false; reasons: string[]; drop?: boolean } {
	const reasons: string[] = [];

	if (value(raw, "patient_id") === "") {
		return { ok: false, reasons: ["missing_patient_id"], drop: true };
	}

	for (const field of REQUIRED_FIELDS) {
		if (value(raw, field) === "") {
			reasons.push(`missing_${field}`);
		}
	}

	const rawEnrollmentDate = value(raw, "enrollment_date");
	const enrollmentDate =
		rawEnrollmentDate === "" ? null : parseDate(rawEnrollmentDate);
	if (enrollmentDate !== null && !enrollmentDate.ok) {
		reasons.push(`enrollment_${enrollmentDate.reason}`);
	}
	const enrollmentIso = enrollmentDate?.ok === true ? enrollmentDate.iso : "";

	const rawLastVisitDate = value(raw, "last_visit_date");
	const lastVisitDate =
		rawLastVisitDate === "" ? null : parseDate(rawLastVisitDate);
	if (lastVisitDate !== null && !lastVisitDate.ok) {
		reasons.push(`last_visit_${lastVisitDate.reason}`);
	}
	const lastVisitIso = lastVisitDate?.ok === true ? lastVisitDate.iso : "";

	if (
		lastVisitIso !== "" &&
		enrollmentIso !== "" &&
		lastVisitIso < enrollmentIso
	) {
		reasons.push("date_inconsistency");
	}

	const rawAge = value(raw, "age");
	const age = Number(rawAge);
	if (rawAge !== "" && !Number.isInteger(age)) reasons.push("invalid_age");
	else if (rawAge !== "" && (age < 18 || age > 120))
		reasons.push("implausible_age");

	const rawWeight = value(raw, "weight_kg");
	const weight = Number(rawWeight);
	if (rawWeight !== "" && !Number.isFinite(weight))
		reasons.push("invalid_weight");
	else if (rawWeight !== "" && (weight < 30 || weight > 250))
		reasons.push("implausible_weight");

	const rawSex = value(raw, "sex");
	const sex = rawSex === "" ? null : parseSex(rawSex);
	if (rawSex !== "" && sex === null) reasons.push("invalid_sex");

	const rawStatus = value(raw, "status");
	const status = rawStatus === "" ? null : parseStatus(rawStatus);
	if (rawStatus !== "" && status === null) reasons.push("invalid_status");

	const doseLevel = normalizeDoseLevel(value(raw, "dose_level"));

	if (containsSuspectedPii(value(raw, "lab_notes"))) {
		reasons.push("suspected_pii");
	}

	if (reasons.length > 0) {
		return { ok: false, reasons };
	}

	return {
		ok: true,
		warnings: doseLevel.warnings,
		record: {
			patientId: value(raw, "patient_id"),
			trialId: value(raw, "trial_id"),
			siteId: value(raw, "site_id"),
			enrollmentDate: enrollmentIso,
			age,
			sex: sex as PatientRecord["sex"],
			weight,
			doseLevel: doseLevel.value,
			adverseEvents: parseAdverseEvents(value(raw, "adverse_events")),
			labNotes: value(raw, "lab_notes"),
			responseAssessment: parseResponse(value(raw, "response_assessment")),
			lastVisitDate: lastVisitIso,
			status: status as PatientRecord["status"],
		},
	};
}

/**
 * Build a stable identity fingerprint for a normalized record.
 * The unit-separator delimiter (\x1f) is used because it cannot occur in
 * the upstream CSV data, so the joined string is unambiguous.
 */
function recordFingerprint(record: PatientRecord): string {
	return [
		record.trialId,
		record.siteId,
		record.enrollmentDate,
		String(record.age),
		record.sex,
		String(record.weight),
		record.doseLevel,
		[...record.adverseEvents].sort().join(","),
		record.responseAssessment ?? "",
		record.lastVisitDate,
		record.status,
	].join("\x1f");
}

/**
 * Run the pipeline against a CSV source and produce clean + quarantined
 * records plus a summary of what happened.
 */
export function runPipeline(options: PipelineOptions): PipelineResult {
	if (options.csvText === undefined && options.csvPath === undefined) {
		throw new Error("runPipeline requires csvPath or csvText");
	}

	const text =
		options.csvText !== undefined
			? options.csvText
			: readFileSync(options.csvPath as string, "utf8");

	const { rows } = parseCsv(text);

	const clean: PatientRecord[] = [];
	const quarantined: PipelineResult["quarantined"] = [];
	const issuesFound: Record<string, number> = {};
	// Drops are for rows that can't even be productively reviewed (e.g. missing
	// primary key). Quarantine is for recoverable rows. See DECISIONS.md.
	let dropped = 0;

	const countIssue = (issue: string, amount = 1): void => {
		issuesFound[issue] = (issuesFound[issue] ?? 0) + amount;
	};

	// Single pass: normalize each row, then immediately reconcile against any
	// previously-seen row for the same patient.
	const seenByPatient = new Map<string, PatientEntry>();

	for (const raw of rows) {
		const result = normalizeRow(raw);
		if (!result.ok) {
			if (result.drop === true) {
				dropped += 1;
			} else {
				quarantined.push({ record: raw, reasons: result.reasons });
			}
			for (const reason of result.reasons) countIssue(reason);
			continue;
		}

		const fingerprint = recordFingerprint(result.record);
		const existing = seenByPatient.get(result.record.patientId);

		if (existing === undefined) {
			seenByPatient.set(result.record.patientId, {
				record: result.record,
				raw,
				warnings: result.warnings,
				fingerprint,
				duplicates: 0,
				conflictingRaws: [],
			});
		} else if (existing.fingerprint === fingerprint) {
			existing.duplicates += 1;
		} else {
			existing.conflictingRaws.push(raw);
		}
	}

	for (const entry of seenByPatient.values()) {
		if (entry.conflictingRaws.length > 0) {
			// Quarantine every row in the conflict group, including the first
			// occurrence, so reviewers see the full set side-by-side.
			quarantined.push({
				record: entry.raw,
				reasons: ["conflicting_duplicate"],
			});
			countIssue("conflicting_duplicate");
			for (const conflictRaw of entry.conflictingRaws) {
				quarantined.push({
					record: conflictRaw,
					reasons: ["conflicting_duplicate"],
				});
				countIssue("conflicting_duplicate");
			}
			continue;
		}

		clean.push(entry.record);
		for (const warning of entry.warnings) countIssue(warning);
		if (entry.duplicates > 0) countIssue("exact_duplicate", entry.duplicates);
	}

	return {
		clean,
		quarantined,
		summary: {
			totalInput: rows.length,
			totalClean: clean.length,
			totalQuarantined: quarantined.length,
			totalDropped: dropped,
			issuesFound,
		},
	};
}
