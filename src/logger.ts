/** In-memory sync log shown by the "View sync log" command. */
export class SyncLog {
	private entries: string[] = [];
	private static readonly MAX_ENTRIES = 1000;

	add(message: string) {
		const time = new Date().toLocaleTimeString();
		this.entries.push(`[${time}] ${message}`);
		if (this.entries.length > SyncLog.MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - SyncLog.MAX_ENTRIES);
		}
	}

	get text(): string {
		return this.entries.length ? this.entries.join("\n") : "No sync activity yet.";
	}

	clear() {
		this.entries = [];
	}
}
