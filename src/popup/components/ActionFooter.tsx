import type { AppState, ReadinessState } from '@shared/types';

interface ActionFooterProps {
  busy: boolean;
  hasRepo: boolean;
  hasEndpoints: boolean;
  hasArtifact: boolean;
  skipExistingEnabled: boolean;
  selectedEligibleCount: number;
  selectedEndpointCount: number;
  onScan: () => void;
  onGenerate: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onClear: () => void;
  onExportPostman?: () => void;
  jobStage?: AppState['activeJob'] extends null ? undefined : string;
  readiness?: ReadinessState;
  readinessNotes?: string[];
}

export function ActionFooter({
  busy,
  hasRepo,
  hasEndpoints,
  hasArtifact,
  skipExistingEnabled,
  selectedEligibleCount,
  selectedEndpointCount,
  onScan,
  onGenerate,
  onDownload,
  onCancel,
  onClear,
  onExportPostman,
  jobStage,
  readiness,
  readinessNotes,
}: ActionFooterProps) {
  const readinessLabel = readiness
    ? readiness.replace(/_/g, ' ')
    : null;

  return (
    <footer className="actions">
      {readinessLabel ? (
        <p className={`subtle readiness readiness-${readiness}`}>
          Readiness: <strong>{readinessLabel}</strong>
          {readinessNotes?.[0] ? ` • ${readinessNotes[0]}` : ''}
        </p>
      ) : null}
      <button type="button" onClick={onScan} disabled={busy || !hasRepo}>
        Scan Repo
      </button>
      <button
        type="button"
        onClick={onGenerate}
        disabled={busy || !hasEndpoints || (skipExistingEnabled ? !selectedEligibleCount : !selectedEndpointCount)}
      >
        Generate Tests
      </button>
      <button type="button" onClick={onDownload} disabled={!hasArtifact}>
        Download {readiness === 'production_candidate' ? 'Validated Tests' : 'Tests'}
      </button>
      {jobStage === 'complete' && onExportPostman ? (
        <button type="button" className="ghost" onClick={onExportPostman}>
          Export Postman
        </button>
      ) : null}
      {busy ? (
        <button type="button" onClick={onCancel} className="ghost cancel-btn">
          Cancel
        </button>
      ) : (
        <button type="button" onClick={onClear} className="ghost">
          Clear
        </button>
      )}
    </footer>
  );
}
