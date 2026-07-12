/**
 * Shell-style input history, pure and Ink-free. The composer drives it from
 * arrow keys; persistence is the entrypoint's job (the class only sees
 * strings, so tests use in-memory arrays).
 */

const CAP = 500;

export class InputHistory {
  #entries: string[];
  /** Index into #entries while browsing; null = at the live draft. */
  #cursor: number | null = null;
  /** The draft that was being typed when browsing started. */
  #stash = "";

  constructor(initial: string[] = []) {
    this.#entries = initial.slice(-CAP);
  }

  /** Record a submitted input. Consecutive duplicates collapse. */
  push(text: string): void {
    this.#cursor = null;
    if (!text || this.#entries.at(-1) === text) return;
    this.#entries.push(text);
    if (this.#entries.length > CAP) this.#entries.shift();
  }

  /**
   * Step to the previous (older) entry. The first step stashes the current
   * draft so `next` can restore it. Stays on the oldest entry at the top.
   * Returns null only when there is no history at all.
   */
  prev(currentDraft: string): string | null {
    if (this.#entries.length === 0) return null;
    if (this.#cursor === null) {
      this.#stash = currentDraft;
      this.#cursor = this.#entries.length - 1;
    } else if (this.#cursor > 0) {
      this.#cursor -= 1;
    }
    return this.#entries[this.#cursor] ?? null;
  }

  /**
   * Step to the next (newer) entry; stepping past the newest restores the
   * stashed draft. Returns null when not browsing (nothing to do).
   */
  next(): string | null {
    if (this.#cursor === null) return null;
    if (this.#cursor < this.#entries.length - 1) {
      this.#cursor += 1;
      return this.#entries[this.#cursor] ?? null;
    }
    this.#cursor = null;
    return this.#stash;
  }
}
