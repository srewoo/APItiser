import type { AppState, JobState } from '@shared/types';

interface ProgressTimelineProps {
  activeOrLatestJob: JobState | null;
  visibleQualityIssues: AppState['activeJob'] extends null ? never[] : NonNullable<JobState['batchDiagnostics']>[number]['assessment']['issues'];
  qualityStatusLabel: string | undefined;
  latestBatchDiagnostic: NonNullable<JobState['batchDiagnostics']>[number] | undefined;
}

const stageOrder = ['scanning', 'parsing', 'generating', 'validating', 'packaging', 'complete'] as const;
type JobStage = typeof stageOrder[number] | 'idle' | 'error' | 'cancelled';

const isActiveStage = (stage: JobStage | undefined, check: typeof stageOrder[number]): 'done' | 'active' | 'todo' => {
  if (!stage || stage === 'idle') return 'todo';
  const currentIndex = stageOrder.indexOf(stage as typeof stageOrder[number]);
  const checkIndex = stageOrder.indexOf(check);
  if (stage === 'error' || stage === 'cancelled') return check === 'complete' ? 'todo' : 'done';
  if (currentIndex > checkIndex) return 'done';
  if (currentIndex === checkIndex) return 'active';
  return 'todo';
};

export function ProgressTimeline({ activeOrLatestJob, visibleQualityIssues, qualityStatusLabel, latestBatchDiagnostic }: ProgressTimelineProps) {
  return (
    <section className="panel timeline">
      <h2>Progress</h2>
      <div className="steps">
        {stageOrder.map((stage) => (
          <span key={stage} className={`step ${isActiveStage(activeOrLatestJob?.stage as JobStage, stage)}`}>
            {stage}
          </span>
        ))}
      </div>
      <div className="progress-wrap">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${activeOrLatestJob?.progress ?? 0}%` }} />
        </div>
        <strong>{activeOrLatestJob?.progress ?? 0}%</strong>
      </div>
      <p className="subtle">{activeOrLatestJob?.statusText ?? 'No active job'}</p>
      {activeOrLatestJob?.resumedFromCheckpoint ? (
        <p className="subtle">Recovered from checkpoint after worker restart.</p>
      ) : null}
      {qualityStatusLabel ? (
        <div className={`quality-box quality-${qualityStatusLabel}`}>
          <p className="quality-summary">
            <strong>Quality gate:</strong> {qualityStatusLabel}
            {activeOrLatestJob?.repairAttempts ? ` • repair passes ${activeOrLatestJob.repairAttempts}` : ''}
          </p>
          {latestBatchDiagnostic?.repairAttempted ? (
            <p className="subtle">Latest batch required repair before acceptance.</p>
          ) : null}
          {visibleQualityIssues.map((issue) => (
            <p key={`${issue.code}-${issue.message}`} className={`quality-issue ${issue.severity}`}>
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      {activeOrLatestJob?.validationSummary ? (
        <div className="quality-box quality-pending">
          <p className="quality-summary">
            <strong>Live validation:</strong> {activeOrLatestJob.validationSummary.passed}/{activeOrLatestJob.validationSummary.attempted} passed
            {activeOrLatestJob.validationSummary.repaired ? ` • repair rounds ${activeOrLatestJob.validationSummary.repaired}` : ''}
          </p>
          {activeOrLatestJob.validationSummary.notRunReason ? (
            <p className="quality-issue warn">{activeOrLatestJob.validationSummary.notRunReason}</p>
          ) : null}
          {activeOrLatestJob.validationSummary.warnings?.slice(0, 2).map((warning) => (
            <p key={warning} className="quality-issue warn">
              {warning}
            </p>
          ))}
          {activeOrLatestJob.validationSummary.results.filter((result) => !result.success).slice(0, 3).map((result) => (
            <p key={`${result.endpointId}-${result.title}`} className="quality-issue error">
              {result.title}: {result.failures[0]?.message}
            </p>
          ))}
        </div>
      ) : null}
      {activeOrLatestJob?.readiness ? (
        <div className="quality-box quality-pending">
          <p className="quality-summary">
            <strong>Readiness:</strong> {activeOrLatestJob.readiness.replace(/_/g, ' ')}
          </p>
          {activeOrLatestJob.readinessNotes?.slice(0, 2).map((note) => (
            <p key={note} className="quality-issue warn">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
