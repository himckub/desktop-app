// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionList } from '@/renderer/hub/chat-v2/OptionList';
import type { OptionListPayload } from '@/renderer/hub/chat-v2/htmlBlocks';
import { _resetSubmissionCacheForTests } from '@/renderer/hub/chat-v2/optionListStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderOptions(payload: OptionListPayload, sessionId = 'session-1'): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OptionList payload={payload} complete sessionId={sessionId} />);
  });
  return { container, root };
}

function keydown(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('OptionList', () => {
  beforeEach(() => {
    _resetSubmissionCacheForTests();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        sessions: {
          resume: vi.fn(async () => ({ resumed: true })),
        },
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not show section 0 when only missing Other text blocks submit', () => {
    const payload: OptionListPayload = {
      sections: [
        {
          multiSelect: false,
          min: 1,
          max: 1,
          allowOther: true,
          options: [{ id: 'a', image: 'i', title: 'A' }],
        },
        {
          multiSelect: false,
          min: 1,
          max: 1,
          allowOther: false,
          options: [{ id: 'b', image: 'i', title: 'B' }],
        },
      ],
    };
    const { container, root } = renderOptions(payload);

    act(() => {
      container.querySelector<HTMLElement>('.chatv2-optlist__card--other')?.click();
      container.querySelectorAll<HTMLButtonElement>('button.chatv2-optlist__card')[1]?.click();
    });

    const label = container.querySelector<HTMLButtonElement>('.chatv2-optlist__submit')?.textContent ?? '';
    expect(label).toBe('Type your "Other" answer');
    expect(label).not.toContain('section 0');

    act(() => root.unmount());
  });

  it('submits the option selected by the same Enter keypress', async () => {
    const payload: OptionListPayload = {
      sections: [{
        multiSelect: false,
        min: 1,
        max: 1,
        allowOther: false,
        options: [
          { id: 'a', image: 'i', title: 'A' },
          { id: 'b', image: 'i', title: 'B' },
        ],
      }],
    };
    const resume = vi.fn<(
      sessionId: string,
      message: string,
    ) => Promise<{ resumed: boolean }>>(async () => ({ resumed: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { sessions: { resume } },
    });
    const { container, root } = renderOptions(payload);
    const grid = container.querySelector<HTMLElement>('.chatv2-optlist__grid');
    expect(grid).not.toBeNull();

    act(() => {
      container.querySelectorAll<HTMLButtonElement>('.chatv2-optlist__card')[0]?.click();
    });
    act(() => {
      keydown(grid!, 'ArrowRight');
    });
    await act(async () => {
      keydown(grid!, 'Enter');
      await Promise.resolve();
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][1]).toContain('id: b');
    expect(resume.mock.calls[0][1]).not.toContain('id: a');

    act(() => root.unmount());
  });
});
