import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FixReviewModal } from '@popup/components/FixReviewModal';

afterEach(cleanup);

describe('FixReviewModal', () => {
  it('shows the diff and only applies on Accept', () => {
    const onAccept = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <FixReviewModal heading="Fix test: x" sections={[{ label: 'Test', before: 'a\nb', after: 'a\nc' }]} acceptLabel="Accept and re-run" onAccept={onAccept} onClose={onClose} />
    );
    expect(container.querySelector('.diff-del')?.textContent).toBe('- b\n');
    expect(container.querySelector('.diff-add')?.textContent).toBe('+ c\n');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept and re-run' }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('shows an error with no way to accept', () => {
    render(<FixReviewModal heading="h" sections={[]} error="no fix" acceptLabel="Accept" onAccept={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('no fix');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});
