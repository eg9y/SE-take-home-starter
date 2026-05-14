import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runPipeline } from "../services/data-pipeline.js";
import type { PatientRecord, PipelineResult } from "../types.js";

const DEFAULT_INPUT_PATH = "data/incoming_patient_data.csv";
const DEFAULT_CLEAN_PATH = "data/generated/clean_patient_data.csv";
const DEFAULT_QUARANTINE_PATH = "data/generated/quarantined_patient_data.csv";
const DEFAULT_SUMMARY_PATH = "data/generated/pipeline_summary.json";

const CSV_HEADERS = [
	"patient_id",
	"trial_id",
	"site_id",
	"enrollment_date",
	"age",
	"sex",
	"weight_kg",
	"dose_level",
	"adverse_events",
	"lab_notes",
	"response_assessment",
	"last_visit_date",
	"status",
] as const;

type CsvRow = Record<string, unknown>;

function csvEscape(value: unknown): string {
	const text = Array.isArray(value) ? value.join(";") : value === null || value === undefined ? "" : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: CsvRow[], headers: readonly string[]): string {
	const lines = [
		headers.map(csvEscape).join(","),
		...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
	];

	return `${lines.join("\n")}\n`;
}

function writeFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
}

function cleanRecordToRow(record: PatientRecord): CsvRow {
	return {
		patient_id: record.patientId,
		trial_id: record.trialId,
		site_id: record.siteId,
		enrollment_date: record.enrollmentDate,
		age: record.age,
		sex: record.sex,
		weight_kg: record.weight,
		dose_level: record.doseLevel,
		adverse_events: record.adverseEvents,
		lab_notes: record.labNotes,
		response_assessment: record.responseAssessment,
		last_visit_date: record.lastVisitDate,
		status: record.status,
	};
}

function quarantineRecordToRow({ record, reasons }: PipelineResult["quarantined"][number]): CsvRow {
	return { ...record, reasons };
}

const inputPath = resolve(process.argv[2] ?? DEFAULT_INPUT_PATH);
const cleanPath = resolve(process.argv[3] ?? DEFAULT_CLEAN_PATH);
const quarantinePath = resolve(process.argv[4] ?? DEFAULT_QUARANTINE_PATH);
const summaryPath = resolve(process.argv[5] ?? DEFAULT_SUMMARY_PATH);

const result = runPipeline({ csvPath: inputPath });

writeFile(cleanPath, toCsv(result.clean.map(cleanRecordToRow), CSV_HEADERS));
writeFile(quarantinePath, toCsv(result.quarantined.map(quarantineRecordToRow), [...CSV_HEADERS, "reasons"]));
writeFile(summaryPath, `${JSON.stringify(result.summary, null, 2)}\n`);

console.log(`Input: ${inputPath}`);
console.log(`Clean CSV: ${cleanPath} (${result.summary.totalClean} rows)`);
console.log(`Quarantine CSV: ${quarantinePath} (${result.summary.totalQuarantined} rows)`);
console.log(`Summary JSON: ${summaryPath}`);
console.log(`Dropped rows: ${result.summary.totalDropped}`);
