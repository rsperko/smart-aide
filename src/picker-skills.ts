import { App, FuzzySuggestModal } from 'obsidian';
import type { Skill } from './skills';

export class SkillPickerModal extends FuzzySuggestModal<Skill> {
	constructor(
		app: App,
		private skills: Skill[],
		private onPick: (skill: Skill) => void,
	) {
		super(app);
		this.setPlaceholder('Invoke a skill…');
		this.setInstructions([
			{ command: '↑↓', purpose: 'navigate' },
			{ command: '↵', purpose: 'invoke skill' },
			{ command: 'esc', purpose: 'dismiss' },
		]);
	}

	getItems(): Skill[] {
		return this.skills;
	}

	getItemText(skill: Skill): string {
		return `${skill.name} — ${skill.description}`;
	}

	onChooseItem(skill: Skill): void {
		this.onPick(skill);
	}
}
