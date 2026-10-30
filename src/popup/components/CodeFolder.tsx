import { useState } from 'react';
import type { CodeSource } from '@shared/types';

export interface PickedFolder {
  path?: string;
  /** "host/owner/repo" of the folder's git origin, when it's a clone. */
  origin?: string;
  cancelled?: boolean;
}

export interface CodeFolderProps {
  /** "github.com/owner/repo" for the repo on this page. */
  repoSlug: string;
  /** The folder the user chose for this repo, if any. */
  chosenPath?: string;
  /** What the last Start of this repo actually used. */
  source?: CodeSource;
  disabled?: boolean;
  onPickFolder: () => Promise<PickedFolder>;
  /** Save a folder for this repo, or undefined to go back to automatic. */
  onSave: (path: string | undefined) => void;
}

const KIND_LABEL: Record<CodeSource['kind'], string> = {
  chosen: 'your chosen folder',
  found: 'your existing clone, found automatically',
  cloned: 'cloned by APItiser into your clone folder',
  managed: 'cloned by APItiser'
};

/** Which folder Start boots for this repo — shown, and changeable per repo. */
export function CodeFolder({ repoSlug, chosenPath, source, disabled, onPickFolder, onSave }: CodeFolderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const [browsing, setBrowsing] = useState(false);

  const shownPath = chosenPath ?? source?.path;
  const kind = chosenPath ? 'chosen' : source?.kind;

  const startEditing = () => {
    setDraft(shownPath ?? '');
    setProblem('');
    setEditing(true);
  };

  const browse = async () => {
    setBrowsing(true);
    setProblem('');
    try {
      const picked = await onPickFolder();
      if (picked.cancelled || !picked.path) return;
      setDraft(picked.path);
      if (picked.origin && picked.origin !== repoSlug) {
        setProblem(`That folder is a clone of ${picked.origin}, not ${repoSlug}.`);
      } else if (!picked.origin) {
        setProblem('That folder is not a git clone — Start will still try it, but check it holds this repo.');
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not open the folder picker — type the path instead.');
    } finally {
      setBrowsing(false);
    }
  };

  const save = () => {
    const path = draft.trim();
    if (!path) {
      setProblem('Enter a folder, or use automatic.');
      return;
    }
    if (problem.includes(', not ')) return; // a clone of a different repo — never save it
    onSave(path);
    setEditing(false);
  };

  if (!editing) {
    return (
      <p className="code-folder subtle">
        Code:{' '}
        {shownPath ? (
          <>
            <code title={shownPath}>{shownPath}</code> ({KIND_LABEL[kind ?? 'found']})
          </>
        ) : (
          'found or cloned automatically when you press Start'
        )}{' '}
        <button type="button" className="link-btn" onClick={startEditing} disabled={disabled}>
          Change
        </button>
        {chosenPath ? (
          <>
            {' · '}
            <button type="button" className="link-btn" onClick={() => onSave(undefined)} disabled={disabled}>
              Use automatic
            </button>
          </>
        ) : null}
      </p>
    );
  }

  return (
    <div className="code-folder-edit">
      <label>
        Folder for {repoSlug}
        <input
          type="text"
          value={draft}
          placeholder="/Users/you/code/my-api"
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem('');
          }}
        />
      </label>
      {problem ? <p className={problem.includes(', not ') ? 'run-warning' : 'subtle'}>{problem}</p> : null}
      <div className="endpoint-control-actions">
        <button type="button" className="ghost endpoint-control-btn" onClick={() => void browse()} disabled={browsing}>
          {browsing ? 'Choosing…' : 'Browse…'}
        </button>
        <button type="button" className="ghost endpoint-control-btn" onClick={save}>
          Save
        </button>
        <button type="button" className="link-btn" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
