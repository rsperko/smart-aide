import { dailyNote } from './daily-note';
import { handwritingOcr } from './handwriting-ocr';
import { meetingNotes } from './meeting-notes';
import { mocBuilder } from './moc-builder';
import { processInbox } from './process-inbox';
import { weeklyReview } from './weekly-review';
import type { SampleSkill } from './types';

/** Order = display order in the settings UI. Cheapest / simplest first. */
export const SAMPLE_SKILLS: SampleSkill[] = [
	handwritingOcr,
	meetingNotes,
	dailyNote,
	processInbox,
	mocBuilder,
	weeklyReview,
];

export type { SampleSkill, SampleInstallState, SampleInstallStatus, InstallResult } from './types';
export { installSample, readSampleStatus } from './types';
