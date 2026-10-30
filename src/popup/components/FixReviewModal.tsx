import { lineDiff } from '@shared/lineDiff';

export interface FixSection {
  label: string;
  before: string;
  after: string;
}

interface FixReviewModalProps {
  heading: string;
  /** Why the fix is proposed / what it changes, in plain words. */
  explanation?: string;
  sections: FixSection[];
  loading?: boolean;
  /** Shown while loading, e.g. "Asking the model for a fix…". */
  loadingText?: string;
  error?: string;
  applying?: boolean;
  acceptLabel: string;
  /** Extra caution shown next to Accept (e.g. "edits your source files"). */
  warning?: string;
  onAccept: () => void;
  onClose: () => void;
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="fix-diff">
      {lineDiff(before, after).map((line, index) => (
        <span key={index} className={`diff-${line.kind}`}>
          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** Review a proposed fix as a diff. Nothing is applied unless the user accepts. */
export function FixReviewModal({
  heading,
  explanation,
  sections,
  loading,
  loadingText,
  error,
  applying,
  acceptLabel,
  warning,
  onAccept,
  onClose
}: FixReviewModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="panel modal-panel fix-review" role="dialog" aria-modal="true" aria-label={heading} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{heading}</h2>
          <button type="button" className="ghost modal-close" onClick={onClose}>
            Close
          </button>
        </div>
        {loading ? <p className="subtle">{loadingText ?? 'Working…'}</p> : null}
        {error ? <p className="run-warning" role="alert">{error}</p> : null}
        {explanation ? <p>{explanation}</p> : null}
        {sections.map((section) => (
          <div key={section.label} className="fix-section">
            <p><code>{section.label}</code></p>
            <Diff before={section.before} after={section.after} />
          </div>
        ))}
        {sections.length && !error ? (
          <div className="endpoint-control-actions">
            <button type="button" onClick={onAccept} disabled={applying}>
              {applying ? 'Applying…' : acceptLabel}
            </button>
            <button type="button" className="ghost" onClick={onClose} disabled={applying}>
              Reject
            </button>
            {warning ? <span className="subtle">{warning}</span> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
