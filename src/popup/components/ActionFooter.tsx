import type { AppState } from '@shared/types';

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
}: ActionFooterProps) {
  return (
    <footer className="actions">
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
        Download Tests
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
