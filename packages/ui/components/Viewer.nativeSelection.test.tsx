/** Touch selection must stay native until an explicit toolbar action. */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const viewer = hasDom ? await import('./Viewer') : null;
const parser = hasDom ? await import('../utils/parser') : null;
let root: Root | null = null;
let host: HTMLElement;
let originalMatchMedia: typeof window.matchMedia;
const annotations: Annotation[] = [];

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

async function mount(inputMethod: 'drag' | 'pinpoint' = 'drag', readOnly = false) {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: coarse)', media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => true, onchange: null,
  })) as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.append(host);
  const markdown = 'Alpha beta gamma delta.\n';
  const Viewer = viewer!.Viewer;
  await act(async () => {
    root = createRoot(host);
    root.render(<Viewer
      markdown={markdown} blocks={parser!.parseMarkdownToBlocks(markdown)}
      annotations={[]} onAddAnnotation={ann => annotations.push(ann)}
      onSelectAnnotation={() => {}} selectedAnnotationId={null}
      mode="selection" readOnly={readOnly} inputMethod={inputMethod} taterMode={false} stickyActions={false} disableCodePathValidation
    />);
  });
  await settle();
}

async function select(start: number, end: number) {
  const node = host.querySelector('[data-block-id] p')?.firstChild
    ?? host.querySelector('p[data-block-id]')?.firstChild
    ?? host.querySelector('article p')!.firstChild!;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  await act(async () => {
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    node.parentElement!.dispatchEvent(new Event('touchend', { bubbles: true }));
  });
  await settle();
}

function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')]
    .find(el => (el.getAttribute('aria-label') ?? el.title) === name)!;
}

async function click(name: string) {
  await act(async () => { button(name).click(); });
  await settle();
}

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  annotations.length = 0;
});

test.skipIf(!hasDom)('toolbar is persistent and idle buttons have no effect; native handles may settle and move', async () => {
  await mount();
  const toolbar = document.querySelector<HTMLElement>('[data-pn-native-selection-toolbar]')!;
  expect(toolbar).not.toBeNull();
  expect(toolbar.style.top).toBe('auto');
  expect(button('Copy')).toBeUndefined();
  expect(button('Cancel')).toBeUndefined();
  for (const name of ['Delete', 'Comment', 'Quick label', 'Looks good']) await click(name);
  expect(annotations).toHaveLength(0);
  expect(!!document.querySelector('textarea')).toBe(false);
  expect(document.querySelector('[data-quick-label-picker]')).toBeNull();
  await select(0, 5);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(window.getSelection()!.toString()).toBe('Alpha');
  expect(host.querySelector('mark')).toBeNull();
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  host.querySelector('article')!.dispatchEvent(menu);
  expect(menu.defaultPrevented).toBe(false);
  await select(6, 16);
  await click('Delete');
  expect(annotations).toHaveLength(1);
  expect(annotations[0]!.originalText).toBe('beta gamma');
  expect(annotations[0]!.type).toBe(AnnotationType.DELETION);
  expect(host.querySelector('mark.deletion')?.textContent).toBe('beta gamma');
  expect(host.querySelector('.native-selection-pending')).toBeNull();
  expect(window.getSelection()!.isCollapsed).toBe(true);
  expect(document.querySelector('[data-pn-native-selection-toolbar]')).toBe(toolbar);
});

test.skipIf(!hasDom)('canceling a native selection leaves no stale action target', async () => {
  await mount();
  await select(0, 5);
  await act(async () => {
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await click('Delete');
  await click('Comment');
  expect(annotations).toHaveLength(0);
  expect(host.querySelector('mark')).toBeNull();
  expect(!!document.querySelector('textarea')).toBe(false);
});

test.skipIf(!hasDom)('comment cancellation clears the selection and pending anchor; reactions still commit', async () => {
  await mount();
  await select(6, 10);
  await click('Comment');
  expect(document.querySelector('textarea')).not.toBeNull();
  expect(window.getSelection()!.isCollapsed).toBe(true);
  expect(host.querySelector('mark.native-selection-pending')?.textContent).toBe('beta');
  await act(async () => {
    document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
  expect(!!document.querySelector('textarea')).toBe(false);
  expect(host.querySelector('mark')).toBeNull();
  await select(11, 16);
  await click('Looks good');
  expect(annotations).toHaveLength(1);
  expect(annotations[0]!.originalText).toBe('gamma');
  expect(host.querySelector('mark.comment')?.textContent).toBe('gamma');
});


test.skipIf(!hasDom)('dismissing the quick-label picker drops its captured target', async () => {
  await mount();
  await select(0, 5);
  await click('Quick label');
  expect(host.querySelector('mark.native-selection-pending')?.textContent).toBe('Alpha');
  await click('Quick label');
  expect(!!host.querySelector('mark')).toBe(false);
  await click('Looks good');
  expect(annotations).toHaveLength(0);
  await select(6, 10);
  await click('Looks good');
  expect(annotations[0]!.originalText).toBe('beta');
});

test.skipIf(!hasDom)('pinpoint keeps its existing toolbar flow', async () => {
  await mount('pinpoint');
  expect(!!document.querySelector('[data-pn-native-selection-toolbar]')).toBe(false);
});

test.skipIf(!hasDom)('submitting a comment commits the selected words and removes the pending preview', async () => {
  await mount();
  await select(6, 10);
  await click('Comment');
  const textarea = document.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')!.set!;
  await act(async () => {
    setter.call(textarea, 'Clarify this');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', metaKey: true, bubbles: true, cancelable: true,
    }));
  });
  await settle();
  expect(annotations).toHaveLength(1);
  expect(annotations[0]!.originalText).toBe('beta');
  expect(annotations[0]!.text).toBe('Clarify this');
  expect(host.querySelector('mark.comment')?.textContent).toBe('beta');
  expect(!!host.querySelector('.native-selection-pending')).toBe(false);
  expect(!!document.querySelector('textarea')).toBe(false);
  expect(window.getSelection()!.isCollapsed).toBe(true);
});


test.skipIf(!hasDom)('a selected quick label annotates the captured words and leaves no pending mark', async () => {
  await mount();
  await select(6, 10);
  await click('Quick label');
  const choice = document.querySelector<HTMLButtonElement>('[data-quick-label-picker] button');
  expect(!!choice).toBe(true);
  await act(async () => { choice!.click(); });
  await settle();
  expect(annotations).toHaveLength(1);
  expect(annotations[0]!.originalText).toBe('beta');
  expect(annotations[0]!.isQuickLabel).toBe(true);
  expect(host.querySelector('mark.comment')?.textContent).toBe('beta');
  expect(!!document.querySelector('[data-quick-label-picker]')).toBe(false);
  expect(!!host.querySelector('.native-selection-pending')).toBe(false);
  expect(window.getSelection()!.isCollapsed).toBe(true);
});

test.skipIf(!hasDom)('outside and whitespace-only selections cannot become annotation targets', async () => {
  await mount();
  const outside = document.createElement('p');
  outside.textContent = 'Text outside the document';
  document.body.appendChild(outside);
  const range = document.createRange();
  range.setStart(outside.firstChild!, 0);
  range.setEnd(outside.firstChild!, 4);
  await act(async () => {
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await click('Delete');
  await click('Comment');
  expect(annotations).toHaveLength(0);
  expect(!!document.querySelector('textarea')).toBe(false);
  expect(window.getSelection()!.toString()).toBe('Text');
  await select(5, 6);
  await click('Delete');
  await click('Quick label');
  expect(annotations).toHaveLength(0);
  expect(!!host.querySelector('mark')).toBe(false);
  expect(!!document.querySelector('[data-quick-label-picker]')).toBe(false);
});

test.skipIf(!hasDom)('a read-only document on a touch device has no mutation toolbar', async () => {
  await mount('drag', true);
  await select(0, 5);
  expect(!!document.querySelector('.annotation-toolbar')).toBe(false);
  expect(window.getSelection()!.toString()).toBe('Alpha');
  expect(!!host.querySelector('mark')).toBe(false);
  expect(annotations).toHaveLength(0);
});
