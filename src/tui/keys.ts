import type { UiState } from './screen.js';

/**
 * Key handling as a pure function: state and keypress in, new state plus an optional command
 * out. The app performs the commands; this file stays trivially testable.
 */

export interface Key {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

export type Command =
  | { type: 'none' }
  | { type: 'quit' }
  | { type: 'force-quit' }
  | { type: 'restart'; index: number }
  | { type: 'toggle'; index: number };

export interface KeyResult {
  ui: UiState;
  command: Command;
}

const none = (ui: UiState): KeyResult => ({ ui, command: { type: 'none' } });

export const handleKey = (ui: UiState, key: Key, rowCount: number): KeyResult => {
  // Ctrl-C always means stop, wherever you are.
  if (key.ctrl && key.name === 'c') {
    return { ui: { ...ui, confirmQuit: false }, command: { type: ui.phase === 'stopping' ? 'force-quit' : 'quit' } };
  }

  if (ui.confirmQuit) {
    if (key.name === 'y' || key.name === 'return') {
      return { ui: { ...ui, confirmQuit: false }, command: { type: 'quit' } };
    }
    return none({ ...ui, confirmQuit: false, note: 'Ready for commands.' });
  }

  if (ui.view === 'help') {
    return none({ ...ui, view: 'overview' });
  }

  const clamp = (index: number): number => Math.min(Math.max(0, index), Math.max(0, rowCount - 1));
  const inLogView = ui.view === 'log' || ui.view === 'merged';

  switch (key.name) {
    case 'q':
      return none({ ...ui, confirmQuit: true });

    case '?':

      return none({ ...ui, view: 'help' });

    case 'escape':
      return none({ ...ui, view: 'overview', scrollBack: 0, follow: true });

    case 's':
      if (inLogView) return none({ ...ui, view: 'overview', scrollBack: 0, follow: true });
      return { ui, command: { type: 'toggle', index: ui.selected } };

    case 't':
      return { ui, command: { type: 'toggle', index: ui.selected } };

    case 'r':
      return { ui, command: { type: 'restart', index: ui.selected } };

    case 'a':
      return none({ ...ui, view: ui.view === 'merged' ? 'overview' : 'merged', scrollBack: 0, follow: true });

    case 'return':
    case 'v':
      if (ui.view === 'overview') return none({ ...ui, view: 'log', scrollBack: 0, follow: true });
      return none(ui);

    case 'up':
    case 'k':
      if (inLogView) return none({ ...ui, scrollBack: ui.scrollBack + 1, follow: false });
      return none({ ...ui, selected: clamp(ui.selected - 1) });

    case 'down':
    case 'j':
      if (inLogView) {
        const scrollBack = Math.max(0, ui.scrollBack - 1);
        return none({ ...ui, scrollBack, follow: scrollBack === 0 });
      }
      return none({ ...ui, selected: clamp(ui.selected + 1) });

    case 'pageup':
      if (inLogView) return none({ ...ui, scrollBack: ui.scrollBack + 10, follow: false });
      return none({ ...ui, selected: clamp(ui.selected - 5) });

    case 'pagedown':
      if (inLogView) {
        const scrollBack = Math.max(0, ui.scrollBack - 10);
        return none({ ...ui, scrollBack, follow: scrollBack === 0 });
      }
      return none({ ...ui, selected: clamp(ui.selected + 5) });

    case 'g':
      if (inLogView) {
        // Shift-G is "bottom", plain g is "top".
        return key.shift
          ? none({ ...ui, scrollBack: 0, follow: true })
          : none({ ...ui, scrollBack: Number.MAX_SAFE_INTEGER, follow: false });
      }
      return none({ ...ui, selected: key.shift ? clamp(rowCount - 1) : 0 });

    case 'f':
      if (inLogView) return none({ ...ui, follow: !ui.follow, scrollBack: ui.follow ? ui.scrollBack : 0 });
      return none(ui);

    case 'home':
      return inLogView ? none({ ...ui, scrollBack: Number.MAX_SAFE_INTEGER, follow: false }) : none({ ...ui, selected: 0 });

    case 'end':
      return inLogView ? none({ ...ui, scrollBack: 0, follow: true }) : none({ ...ui, selected: clamp(rowCount - 1) });

    default: {
      // A digit jumps straight to that process and opens its log — the fast path.
      if (/^[0-9]$/.test(key.name)) {
        const index = Number(key.name);
        if (index < rowCount) {
          return none({ ...ui, selected: index, view: 'log', scrollBack: 0, follow: true });
        }
      }
      return none(ui);
    }
  }
};
