export interface ReconcileOpts {
  terminalStates: string[];
  parkedState: string;
}

export interface ReconcileDecision {
  advanceIndexes: number[];
  closeParent: boolean;
}

function eqName(a: string | null, b: string): boolean {
  return a != null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isTerminalName(s: string | null, terminalStates: string[]): boolean {
  return s != null && terminalStates.some((t) => t.trim().toLowerCase() === s.trim().toLowerCase());
}

export function computeReconcile(states: Array<string | null>, opts: ReconcileOpts): ReconcileDecision {
  const advanceIndexes: number[] = [];
  for (let i = 1; i < states.length; i++) {
    if (isTerminalName(states[i - 1], opts.terminalStates) && eqName(states[i], opts.parkedState)) {
      advanceIndexes.push(i);
    }
  }
  const closeParent = states.length > 0 && states.every((s) => isTerminalName(s, opts.terminalStates));
  return { advanceIndexes, closeParent };
}
