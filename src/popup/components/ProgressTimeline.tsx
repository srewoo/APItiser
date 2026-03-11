import type { AppState, JobState } from '@shared/types';

interface ProgressTimelineProps {
  activeOrLatestJob: JobState | null;
  visibleQualityIssues: AppState['activeJob'] extends null ? never[] : NonNullable<JobState['batchDiagnostics']>[number]['assessment']['issues'];
  qualityStatusLabel: string | undefined;
  latestBatchDiagnostic: NonNullable<JobState['batchDiagnostics']>[number] | undefined;
}

const stageOrder = ['scanning', 'parsing', 'generating', 'packaging', 'complete'] as const;
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
    </section>
  );
}
