import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Save manager for the worksheet.
 *  - run(label, fn, undo?)  performs a save, then reloads the estimate.
 *  - A failed save is kept in `failed` with a retry, never dropped silently.
 *  - Successful saves with an `undo` function go on the undo stack (Ctrl+Z).
 *  - Warns before leaving the page while saves are pending or failed.
 */
export function useSaver(reload) {
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState([]);
  const [lastSaved, setLastSaved] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const busy = useRef(false);

  const run = useCallback(async (label, fn, undo) => {
    setPending((n) => n + 1);
    try {
      const result = await fn();
      setLastSaved(new Date());
      setFailed((f) => f.filter((x) => x.label !== label)); // a corrected edit clears its earlier failure
      if (undo) setUndoStack((s) => [...s.slice(-49), { label, undo }]);
      await reload();
      return result;
    } catch (e) {
      // One entry per change: a repeated failure of the same edit replaces the earlier one
      const entry = { id: Math.random().toString(36).slice(2), label, error: e.message, fn, undo };
      setFailed((f) => [...f.filter((x) => x.label !== label), entry]);
      throw e;
    } finally {
      setPending((n) => n - 1);
    }
  }, [reload]);

  const retry = useCallback(async () => {
    const list = failed; setFailed([]);
    for (const f of list) {
      try { await run(f.label, f.fn, f.undo); } catch { /* run() re-queues it */ }
    }
  }, [failed, run]);

  const dismiss = useCallback((id) => setFailed((f) => f.filter((x) => x.id !== id)), []);

  const undo = useCallback(async () => {
    if (busy.current) return;
    const top = undoStack.at(-1); if (!top) return;
    busy.current = true;
    setUndoStack((s) => s.slice(0, -1));
    try { await run(`Undo: ${top.label}`, top.undo); } catch { /* shown in failed */ } finally { busy.current = false; }
  }, [undoStack, run]);

  useEffect(() => {
    const warn = (e) => { if (pending > 0 || failed.length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending, failed]);

  return { run, pending, failed, retry, dismiss, lastSaved, undo, canUndo: undoStack.length > 0, undoLabel: undoStack.at(-1)?.label };
}
