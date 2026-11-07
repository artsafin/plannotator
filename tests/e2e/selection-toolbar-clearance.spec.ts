/** Mobile native-selection actions, compact geometry, bottom clearance, and desktop parity. */
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { TOUCH_SELECTION_SETTLE_MS } from '../../packages/ui/utils/touchSelection';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { finger } from './phone-touch';

async function withDocument(page: Page, markdown: string, check: () => Promise<void>) {
  const root = inboxScratch('plannotator-toolbar-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const doc = join(root, 'document.md');
  writeFileSync(doc, markdown);
  const ready = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  let url = '';
  try {
    child = spawn(resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator'), ['annotate', doc], {
      cwd: root, stdio: 'ignore',
      env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: '1',
        PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_READY_FILE: ready, PLANNOTATOR_REMOTE: '0',
        PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_CONNECT: '0' },
    });
    await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '').toContain('"url"');
    url = JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url;
    await page.context().addCookies(Object.entries({
      'plannotator-look-feel-announcement-seen': '2',
      'plannotator-plan-look-choice-resolved': 'true',
      'plannotator-announce-tui-herdr-seen': '1',
      'plannotator-announce-inbox-seen': '1',
      'plannotator-announce-ask-session-seen': '1',
      'plannotator-announce-agent-tool-seen': '1',
    }).map(([name, value]) => ({ name, value, url })));
    await page.goto(url);
    await expect(page.locator('article')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await check();
  } finally {
    if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 3000);
        child!.once('exit', () => { clearTimeout(timeout); resolve(undefined); });
      });
      // inbox-guard: own annotate child, never an Inbox.
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  }
}

async function selectWords(page: Page, words: string) {
  await page.locator('article p').first().evaluate((paragraph, text) => {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      // Native touch selection emits selectionchange without a mouseup.
      return;
    }
    throw new Error(`Cannot select ${text}`);
  }, words);
  await expect.poll(() => page.evaluate(() => window.getSelection()!.toString())).toBe(words);
}

const documentText = '# Selection\n\nAlpha beta gamma delta epsilon.\n';
const action = (page: Page, name: string) =>
  page.locator('.annotation-toolbar').locator(`button[title="${name}"], button[aria-label="${name}"]`);

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`mobile ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });
    test('the four centered actions leave the final completion button reachable', async ({ page }) => {
      await withDocument(page, '# Toolbar clearance\n\n' + 'A paragraph for selecting text.\n\n'.repeat(35), async () => {
        const toolbar = page.locator('[data-pn-native-selection-toolbar]');
        const completion = page.getByRole('button', { name: 'Review and finish', exact: true });
        await expect(toolbar).toBeVisible();
        // Deliberate action names: the owner removed Copy and Cancel from this toolbar.
        expect(await toolbar.locator('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label') ?? b.title)))
          .toEqual(['Delete', 'Comment', 'Quick label', 'Looks good']);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(async () => {
          const [dock, button] = await Promise.all([toolbar.boundingBox(), completion.boundingBox()]);
          return button!.y + button!.height <= dock!.y;
        }).toBe(true);
        const dock = (await toolbar.boundingBox())!;
        const spacer = (await page.locator('[data-pn-selection-toolbar-spacer]').boundingBox())!;
        expect(spacer.height).toBe(dock.height);
        expect(dock.width).toBeLessThan(200);
        expect(dock.height).toBeLessThan(50);
        expect(viewport.height - dock.y - dock.height).toBe(12);
        const boxes = await toolbar.locator('button').evaluateAll(buttons => buttons.map(button => {
          const box = button.getBoundingClientRect();
          const icon = button.firstElementChild!.getBoundingClientRect();
          return { width: box.width, height: box.height, left: icon.left - box.left, right: box.right - icon.right };
        }));
        for (const box of boxes) {
          expect(box.width).toBe(36);
          expect(box.height).toBe(36);
          expect(box.left).toBeCloseTo(box.right, 1);
        }
        const edgeInsets = await toolbar.evaluate(bar => {
          const box = bar.getBoundingClientRect();
          const buttons = bar.querySelectorAll('button');
          return { left: buttons[0]!.firstElementChild!.getBoundingClientRect().left - box.left,
            right: box.right - buttons[buttons.length - 1]!.firstElementChild!.getBoundingClientRect().right };
        });
        expect(edgeInsets.left).toBeCloseTo(edgeInsets.right, 1);
      });
    });
  });
}

test.describe('mobile native selection', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('edge-swiped panels cover the bottom toolbar and release it when closed', async ({ page }) => {
    await withDocument(page, documentText, async () => {
      const toolbar = page.locator('[data-pn-native-selection-toolbar]');
      await expect(toolbar).toBeVisible();
      const box = (await toolbar.boundingBox())!;
      const points = [0.15, 0.5, 0.85].map(fraction => ({ x: box.x + box.width * fraction, y: box.y + box.height / 2 }));
      const topSurface = () => page.evaluate(samples => samples.map(point => {
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit?.closest('#pn-compact-plan-navigator')) return 'navigator';
        if (hit?.closest('[data-pn-compact-plan-stage]')) return 'panel';
        if (hit?.closest('[data-pn-native-selection-toolbar]')) return 'toolbar';
        return 'other';
      }), points);
      expect(await topSurface()).toEqual(['toolbar', 'toolbar', 'toolbar']);
      const touch = await finger(page, 'chromium');
      await touch.down(8, 200, 120, 0);
      await touch.up();
      const navigator = page.locator('#pn-compact-plan-navigator');
      await expect(navigator).toBeVisible();
      // Hit-testing at the toolbar's original position checks real stacking, not just z-index values.
      await expect.poll(topSurface).toEqual(['navigator', 'navigator', 'navigator']);
      await touch.down(200, 200, -120, 0);
      await touch.up();
      await expect(navigator).toHaveCount(0);
      expect(await topSurface()).toEqual(['toolbar', 'toolbar', 'toolbar']);

      await touch.down(382, 200, -120, 0);
      await touch.up();
      const annotations = page.getByRole('dialog', { name: 'Annotations', exact: true });
      await expect(annotations).toBeVisible();
      await expect.poll(topSurface).toEqual(['panel', 'panel', 'panel']);
      await annotations.getByRole('button', { name: 'Close Annotations', exact: true }).tap();
      await expect(page.locator('[data-pn-compact-plan-stage]')).toHaveCount(0);
      expect(await topSurface()).toEqual(['toolbar', 'toolbar', 'toolbar']);
    });
  });

  test('selection remains native while ranges change and every action works through a real tap', async ({ page }) => {
    await withDocument(page, documentText, async () => {
      const toolbar = page.locator('[data-pn-native-selection-toolbar]');
      await expect(toolbar).toHaveAttribute('aria-disabled', 'true');
      // Force sends a trusted touch even though aria-disabled intentionally marks these idle controls.
      for (const name of ['Delete', 'Comment', 'Quick label', 'Looks good']) await action(page, name).tap({ force: true });
      await expect(page.locator('article mark, [data-comment-popover], [data-quick-label-picker]')).toHaveCount(0);

      await selectWords(page, 'beta');
      // This wait specifically guards against the retired automatic 400 ms takeover.
      await page.waitForTimeout(TOUCH_SELECTION_SETTLE_MS + 100);
      expect(await page.evaluate(() => window.getSelection()!.toString())).toBe('beta');
      await expect(page.locator('article mark')).toHaveCount(0);
      await selectWords(page, 'beta gamma');
      await expect(toolbar).not.toHaveAttribute('aria-disabled', 'true');
      await action(page, 'Comment').tap();
      const dialog = page.getByRole('dialog', { name: 'Comment', exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.locator('article mark.native-selection-pending')).toHaveText('beta gamma');
      await dialog.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('article mark')).toHaveCount(0);
      expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);

      await selectWords(page, 'delta');
      await action(page, 'Comment').tap();
      await dialog.locator('textarea').fill('Clarify the timing');
      await dialog.getByRole('button', { name: 'Save', exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('article mark.comment').filter({ hasText: 'delta' })).toHaveText('delta');

      await selectWords(page, 'beta');
      await action(page, 'Delete').tap();
      const deleted = page.locator('article mark.deletion').filter({ hasText: 'beta' });
      await expect(deleted).toHaveText('beta');
      expect(await deleted.evaluate(mark => getComputedStyle(mark).textDecorationLine)).toContain('line-through');

      await selectWords(page, 'gamma');
      await action(page, 'Quick label').tap();
      const labels = page.locator('[data-quick-label-picker]');
      await expect(labels).toBeVisible();
      await labels.locator('button').first().tap();
      await expect(labels).toHaveCount(0);
      await expect(page.locator('article mark.comment').filter({ hasText: 'gamma' })).toHaveText('gamma');

      await selectWords(page, 'epsilon');
      await action(page, 'Looks good').tap();
      await expect(page.locator('article mark.comment').filter({ hasText: 'epsilon' })).toHaveText('epsilon');
      await expect(page.locator('.native-selection-pending')).toHaveCount(0);
      expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
      const marks = await page.locator('article mark').count();
      await expect(toolbar).toHaveAttribute('aria-disabled', 'true');
      await action(page, 'Delete').tap({ force: true });
      expect(await page.locator('article mark').count()).toBe(marks);
    });
  });
});

test.describe('desktop compatibility', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
  test('selection still opens the original toolbar with Copy, Cancel and type-to-comment', async ({ page }) => {
    await withDocument(page, documentText, async () => {
      const toolbar = page.locator('.annotation-toolbar');
      await expect(toolbar).toHaveCount(0);
      await expect(page.locator('[data-pn-native-selection-toolbar]')).toHaveCount(0);
      expect(await page.locator('[data-pn-selection-toolbar-spacer]').evaluate(n => n.getBoundingClientRect().height)).toBe(0);
      await selectWords(page, 'beta');
      // Desktop commits the selection on mouseup, as before.
      await page.locator('article p').first().dispatchEvent('mouseup');
      await expect(toolbar).toBeVisible();
      await expect(action(page, 'Copy')).toBeVisible();
      await expect(action(page, 'Cancel')).toBeVisible();
      await expect(page.locator('article mark.annotation-highlight')).toHaveText('beta');
      const controls = await toolbar.locator('button').evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
      for (const box of controls) { expect(box.width).toBe(28); expect(box.height).toBe(28); }
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: async (items: ClipboardItem[]) => { document.documentElement.dataset.copiedTypes = items[0]!.types.join(','); } },
      }));
      await action(page, 'Copy').click();
      await expect(page.locator('html')).toHaveAttribute('data-copied-types', /text\/html/);
      await expect(toolbar).toBeVisible();
      await page.keyboard.type('x');
      const composer = page.locator('[data-comment-popover] textarea');
      await expect(composer).toHaveValue('x');
      await composer.press('Escape');
      await expect(composer).toHaveCount(0);
      await selectWords(page, 'beta');
      await page.locator('article p').first().dispatchEvent('mouseup');
      await action(page, 'Cancel').click();
      await expect(toolbar).toHaveCount(0);
      await expect(page.locator('article mark')).toHaveCount(0);
    });
  });
});
