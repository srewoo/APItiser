import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CodeFolder } from '@popup/components/CodeFolder';

afterEach(cleanup);

const slug = 'github.com/srewoo/fortknoxx';
const base = { repoSlug: slug, onPickFolder: vi.fn(), onSave: vi.fn() };

describe('CodeFolder', () => {
  it('explains the default before any Start', () => {
    render(<CodeFolder {...base} />);
    expect(screen.getByText(/found or cloned automatically when you press Start/)).toBeTruthy();
  });

  it('shows what the last Start used, and how it was found', () => {
    render(<CodeFolder {...base} source={{ path: '/Users/me/FortKnoxx', kind: 'found' }} />);
    expect(screen.getByText('/Users/me/FortKnoxx')).toBeTruthy();
    expect(screen.getByText(/your existing clone, found automatically/)).toBeTruthy();
  });

  it('saves a browsed folder that is a clone of this repo', async () => {
    const onSave = vi.fn();
    const onPickFolder = vi.fn(async () => ({ path: '/Users/me/FortKnoxx', origin: slug }));
    render(<CodeFolder {...base} onSave={onSave} onPickFolder={onPickFolder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(await screen.findByDisplayValue('/Users/me/FortKnoxx')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('/Users/me/FortKnoxx');
  });

  it('refuses a folder that is a clone of a different repo', async () => {
    const onSave = vi.fn();
    const onPickFolder = vi.fn(async () => ({ path: '/Users/me/FlowScribe', origin: 'github.com/srewoo/flowscribe' }));
    render(<CodeFolder {...base} onSave={onSave} onPickFolder={onPickFolder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(await screen.findByText(/is a clone of github.com\/srewoo\/flowscribe, not github.com\/srewoo\/fortknoxx/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('falls back to typing when the picker is unavailable', async () => {
    const onSave = vi.fn();
    const onPickFolder = vi.fn(async () => {
      throw new Error('No folder picker is available (zenity not found) — type the path instead.');
    });
    render(<CodeFolder {...base} onSave={onSave} onPickFolder={onPickFolder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(await screen.findByText(/type the path instead/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('/Users/you/code/my-api'), { target: { value: '~/code/FortKnoxx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('~/code/FortKnoxx');
  });

  it('goes back to automatic', () => {
    const onSave = vi.fn();
    render(<CodeFolder {...base} onSave={onSave} chosenPath="/Users/me/FortKnoxx" />);
    expect(screen.getByText(/your chosen folder/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic' }));
    expect(onSave).toHaveBeenCalledWith(undefined);
  });
});
